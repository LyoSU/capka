import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// Mock the run dependencies so we exercise the real worker→queue→runner→
// realtime→usage→DB wiring without a network LLM or a sandbox.
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Hello" },
            { type: "text-delta", id: "1", delta: " world" },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: "stop",
              // AI SDK 6 V3 nested usage shape.
              usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
        }),
      }),
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
}));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({ tools: {}, close: async () => {} }),
}));
vi.mock("@/lib/memory/extract", () => ({ extractMemories: async () => [] }));

import { pool } from "../db";
import { realtime } from "../realtime";
import { enqueueTask, claimNextTask } from "../tasks/queue";
import { runAgentTask } from "../tasks/runner";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "e2e-user";
const C = "e2e-chat";

run("runAgentTask end-to-end (mock model, real queue/realtime/DB)", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("claims a queued task, streams it, persists message + usage, finalizes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = await realtime.subscribe(`user:${U}`, (d) => events.push(d as Record<string, unknown>));

    await enqueueTask({
      id: "e2e1",
      chatId: C,
      userId: U,
      payload: { uiMessages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }] },
    });

    const task = await claimNextTask("w-e2e");
    expect(task?.id).toBe("e2e1");
    await runAgentTask(task!, "w-e2e");
    await new Promise((r) => setTimeout(r, 300)); // let final NOTIFYs land

    // Realtime: start → text → finish(completed)
    const types = events.map((e) => e.type);
    expect(types).toContain("task:start");
    expect(types).toContain("task:finish");
    const finish = events.find((e) => e.type === "task:finish");
    expect(finish?.status).toBe("completed");
    const text = events.filter((e) => e.type === "task:text-delta").map((e) => e.delta).join("");
    expect(text).toBe("Hello world");

    // Resume contract: task:start is seq 0 and every streaming event carries a
    // strictly increasing seq, so a client resuming mid-stream can tell
    // covered/next/gapped deltas apart. The persisted snapshot's streamSeq must
    // be >= the last delta's seq (parts cover everything published).
    expect(events.find((e) => e.type === "task:start")?.seq).toBe(0);
    const seqs = events
      .filter((e) => typeof e.seq === "number")
      .map((e) => e.seq as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);

    // DB: assistant message persisted with full text + completed task
    const msg = await pool.query(`SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C]);
    expect(msg.rows[0].content).toBe("Hello world");
    expect(msg.rows[0].metadata.status).toBe("completed");
    const t = await pool.query(`SELECT status FROM tasks WHERE id='e2e1'`);
    expect(t.rows[0].status).toBe("completed");

    // Usage row written (cost null — mock-model not in catalog — but tokens captured)
    const usageRows = await pool.query(`SELECT input_tokens, output_tokens FROM usage WHERE user_id=$1`, [U]);
    expect(usageRows.rows[0].input_tokens).toBe(10);
    expect(usageRows.rows[0].output_tokens).toBe(5);

    unsub();
  }, 30_000);
});
