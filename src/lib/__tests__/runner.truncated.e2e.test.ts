import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// A model that stops because it ran out of output room, not because it was done —
// the provider says `finishReason: "length"`. The reply on screen is whatever fitted,
// and before this was read the turn was persisted as a clean "completed": the user
// saw an answer that simply stopped, with nothing anywhere saying it was cut off.
// (When the cut lands inside a tool call's arguments, that silence is worse still —
// the sandbox runs a program missing its last line and the only evidence is the
// interpreter's syntax error.)
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Here is the first half" },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              // A V3 finish reason is an OBJECT, not a string: `unified` is the
              // cross-provider verdict the SDK normalizes onto `finish-step`, `raw`
              // is what this provider actually said. Passing a bare "length" here
              // leaves `unified` undefined, so the step reports NO finish reason and
              // the truncation check can never fire — a mock that quietly asserts
              // nothing. (The chunk list is cast `as any` for the stream helper, so
              // the compiler can't catch the wrong shape either.)
              finishReason: { unified: "length", raw: "max_tokens" },
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
vi.mock("@/lib/memory/store", () => ({
  readMemoryDocs: async () => ({ user: "", project: "" }),
  maintainMemoryDoc: async () => {},
}));

import { pool } from "../db";
import { realtime } from "../realtime";
import { enqueueTask, claimNextTask } from "../tasks/queue";
import { runAgentTask } from "../tasks/runner";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "e2e-trunc-user";
const C = "e2e-trunc-chat";

run("runAgentTask: the model hit its output-length limit", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e-trunc@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('mt1',$1,'user','write me something long')`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("keeps the partial reply but reports it as cut off, not finished", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = await realtime.subscribe(`user:${U}`, (d) => events.push(d as Record<string, unknown>));

    await enqueueTask({
      id: "e2e-trunc-1",
      chatId: C,
      userId: U,
      payload: { uiMessages: [{ id: "mt1", role: "user", parts: [{ type: "text", text: "write me something long" }] }] },
    });

    const task = await claimNextTask("w-e2e-trunc");
    expect(task?.id).toBe("e2e-trunc-1");
    await runAgentTask(task!, "w-e2e-trunc");
    await new Promise((r) => setTimeout(r, 300)); // let final NOTIFYs land

    const msg = await pool.query(
      `SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`,
      [C],
    );
    // What the model DID produce is kept — the whole point of reporting this as a
    // partial rather than wiping the turn.
    expect(msg.rows[0].content).toBe("Here is the first half");
    expect(msg.rows[0].metadata.status).toBe("failed");
    expect(msg.rows[0].metadata.errorCategory).toBe("response_truncated");

    const t = await pool.query(`SELECT status FROM tasks WHERE id='e2e-trunc-1'`);
    expect(t.rows[0].status).toBe("failed");
    expect(events.find((e) => e.type === "task:finish")?.status).toBe("failed");

    unsub();
  }, 30_000);
});
