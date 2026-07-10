import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Simulate the chat's provider being disconnected / its model removed: the
// model resolution throws BEFORE the assistant message row is inserted. The
// runner used to leave the turn with no row at all (a silent dead-end that read
// as a hang); it must now INSERT a failed message so the user sees what broke.
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => {
    throw new Error("This chat's model is no longer available — its connection was removed.");
  },
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
const U = "e2e-fail-user";
const C = "e2e-fail-chat";

run("runAgentTask: model/provider gone (prepareRun throws before insert)", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e-fail@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    // The user turn the API persists before enqueue: the runner parents its reply
    // to this row (messages.parent_id → messages.id FK), so it must exist first.
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('mf1',$1,'user','hi')`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("inserts a visible failed assistant message and finalizes the task as failed", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = await realtime.subscribe(`user:${U}`, (d) => events.push(d as Record<string, unknown>));

    await enqueueTask({
      id: "e2e-fail-1",
      chatId: C,
      userId: U,
      payload: { uiMessages: [{ id: "mf1", role: "user", parts: [{ type: "text", text: "hi" }] }] },
    });

    const task = await claimNextTask("w-e2e-fail");
    expect(task?.id).toBe("e2e-fail-1");
    await runAgentTask(task!, "w-e2e-fail");
    await new Promise((r) => setTimeout(r, 300)); // let final NOTIFYs land

    // A failed assistant message was INSERTED (not silently dropped) and the
    // chat now points at it, so a reload renders the error in the thread.
    const msg = await pool.query(
      `SELECT id, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`,
      [C],
    );
    expect(msg.rows.length).toBe(1);
    expect(msg.rows[0].metadata.status).toBe("failed");
    expect(msg.rows[0].metadata.error).toBeTruthy();
    expect(msg.rows[0].metadata.errorCategory).toBeTruthy();

    const leaf = await pool.query(`SELECT active_leaf_id FROM chats WHERE id=$1`, [C]);
    expect(leaf.rows[0].active_leaf_id).toBe(msg.rows[0].id);

    const t = await pool.query(`SELECT status FROM tasks WHERE id='e2e-fail-1'`);
    expect(t.rows[0].status).toBe("failed");

    const finish = events.find((e) => e.type === "task:finish");
    expect(finish?.status).toBe("failed");
    expect(finish?.error).toBeTruthy();

    unsub();
  }, 30_000);
});
