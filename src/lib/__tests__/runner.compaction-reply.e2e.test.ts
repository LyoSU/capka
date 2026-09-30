import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { ModelMessage } from "ai";

/**
 * Compaction must summarize the reply that triggered it. The checkpoint is written
 * BELOW that reply and the next turn drops everything up to the checkpoint, so a
 * summary made from the history alone — which ends at the user's message — erased
 * the reply: the model saw neither it nor a recap of it.
 *
 * Travels the real road because the defect is made of the runner's own wiring (which
 * list it hands the compactor), and covers the continuation, whose history already
 * ends at the very row being written — appending the reply there would replay its
 * first half twice.
 */
const REPLY = "There are forty-two active suppliers.";
const FIRST_HALF = "Which quarter did you mean?";
const compacted: ModelMessage[][] = [];
vi.mock("@/lib/chat/context/compactor", () => ({
  compactConversation: async (_m: unknown, _s: unknown, msgs: ModelMessage[]) => {
    compacted.push(msgs);
    return null;
  },
}));
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: REPLY },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              // Past 75% of the default 128k window, so the turn trips compaction.
              usage: { inputTokens: { total: 120_000, noCache: 120_000 }, outputTokens: { total: 8 } },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
        }),
      }),
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
  resolveAuxTarget: async (_userId: string, turn: unknown) => turn,
}));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle: async () => null }));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({ tools: {}, close: async () => {} }),
}));
// Memory stubbed at the same seams the sibling e2e suites stub: this runs against the
// shared database and the real vault would leave rows behind for a fixture user.
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

import { pool } from "../db";
import { runAgentTask, type ClaimedTask } from "../tasks/runner";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "cmp-reply-user";
const C1 = "cmp-reply-chat";
const C2 = "cmp-reply-cont";

async function runTask(id: string, chatId: string, payload: object) {
  // Written already-running rather than enqueued: the dev stack's own worker polls
  // this same database and would claim a `queued` row out from under this suite.
  const { rows } = await pool.query<ClaimedTask>(
    `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload)
     VALUES ($1,$2,$3,'running','w-cmp', now() + interval '300 seconds', $4::jsonb)
     RETURNING *`,
    [id, chatId, U, JSON.stringify(payload)],
  );
  const before = compacted.length;
  await runAgentTask(rows[0], "w-cmp");
  // Compaction is fire-and-forget; wait for the call to land.
  for (let i = 0; i < 100 && compacted.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  const t = await pool.query(`SELECT status FROM tasks WHERE id=$1`, [id]);
  expect(t.rows[0].status).toBe("completed");
  expect(compacted.length).toBe(before + 1);
  return compacted.at(-1)!;
}

run("runAgentTask: compaction summarizes the reply that triggered it", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','cmp-reply@test.local') ON CONFLICT DO NOTHING`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    for (const c of [C1, C2]) {
      await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [c, U]);
      await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [c]);
    }
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('cmp-u1',$1,'user','how many suppliers do we have?')`, [C1]);
    await pool.query(`UPDATE chats SET active_leaf_id='cmp-u1' WHERE id=$1`, [C1]);
    // A continuation: the assistant half that suspended on an `ask` is the leaf.
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('cmp-u2',$1,'user','report on suppliers')`, [C2]);
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('cmp-a2',$1,'cmp-u2','assistant','',$2::jsonb)`,
      [C2, JSON.stringify({ status: "awaiting_answer", parts: [{ type: "text", text: FIRST_HALF }] })],
    );
    await pool.query(`UPDATE chats SET active_leaf_id='cmp-a2' WHERE id=$1`, [C2]);
  });
  afterAll(async () => {
    for (const c of [C1, C2]) {
      await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id=$1)`, [c]);
      await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [c]);
    }
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id IN ($1,$2)`, [C1, C2]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("hands the compactor the history AND the reply, reply last", async () => {
    const msgs = await runTask("cmp-task-1", C1, { replyParentId: "cmp-u1" });
    const conversation = msgs.filter((m) => m.role !== "system");
    // Control: the history is really there, ending at the user's message.
    expect(JSON.stringify(conversation.at(-2)!.content)).toContain("how many suppliers");
    // The finding: the reply follows it, so the summary can cover it.
    const last = conversation.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.content)).toContain(REPLY);
  }, 30_000);

  it("on a continuation, includes the whole reply once — not its first half twice", async () => {
    const msgs = await runTask("cmp-task-2", C2, { resumeMessageId: "cmp-a2" });
    const text = JSON.stringify(msgs.filter((m) => m.role !== "system"));
    expect(text).toContain(REPLY);
    expect(text.split(FIRST_HALF).length - 1).toBe(1);
    expect(msgs.at(-1)!.role).toBe("assistant");
  }, 30_000);
});
