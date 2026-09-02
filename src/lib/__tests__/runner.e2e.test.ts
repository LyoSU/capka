import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// Mock the run dependencies so we exercise the real worker→queue→runner→
// realtime→usage→DB wiring without a network LLM or a sandbox.
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
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
              finishReason: { unified: "stop", raw: "end_turn" },
              // AI SDK 6 V3 nested usage shape. The input split is deliberate:
              // 6 fresh + 1 cache read + 3 cache WRITE = 10 total. Cache writes
              // are billed above base input and live in NEITHER `noCache` nor
              // `cacheRead`, so a ledger that folds only those two silently drops
              // them — which is exactly what the reconcile below asserts it doesn't.
              usage: {
                inputTokens: { total: 10, noCache: 6, cacheRead: 1, cacheWrite: 3 },
                outputTokens: { total: 5 },
              },
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
// Memory is stubbed out whole — spaces included. This suite runs against the shared
// database, and letting the real vault run would leave a space, a topic and claims
// behind for `e2e-user` that this suite's prefix-scoped teardown does not remove.
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

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
    // The user turn the API persists before enqueue: the runner parents its reply
    // to this row (messages.parent_id → messages.id FK), so it must exist first.
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('m1',$1,'user','hi')`, [C]);
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

    // Usage row written (cost null — mock-model not in catalog — but tokens captured).
    // `input_tokens` is the fresh input PLUS the cache writes (6 + 3): the ledger has
    // no separate write column, so folding them here is what keeps the token total
    // whole, while the cost above already charged them at their own rate.
    const usageRows = await pool.query(
      `SELECT input_tokens, output_tokens, cached_input_tokens FROM usage WHERE user_id=$1`,
      [U],
    );
    expect(usageRows.rows[0].input_tokens).toBe(9);
    expect(usageRows.rows[0].output_tokens).toBe(5);
    expect(usageRows.rows[0].cached_input_tokens).toBe(1);

    unsub();
  }, 30_000);
});
