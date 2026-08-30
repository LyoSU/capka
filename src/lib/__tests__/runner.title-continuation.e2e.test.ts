import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

/**
 * Auto-titling has to survive an `ask`/approval continuation, and it did not.
 *
 * A chat whose FIRST turn suspends on an `ask` is answered by a SECOND task writing
 * the same assistant row (`payload.resumeMessageId`). Two separate things then made
 * the title impossible: `isFirstTurn` was read off `modelMessages`, which on that
 * continuation contains the very row being written (`replyParentId` points at it), so
 * it said "not the first turn"; and the title text was `userTurnText`, which is ""
 * on a continuation because `uiMessages` is empty there by design. The first half is
 * skipped by `!awaitingAnswer` and every later turn by `isFirstTurn`, so such a chat
 * kept the `/api/chat` placeholder — a 100-character slice of the opening message —
 * for good.
 *
 * This travels the real road because the defect only exists there: it is made of the
 * runner's own resume wiring, not of anything a helper could be asked about. The
 * fixture is therefore a genuine continuation, and the control is that it really was
 * one — the run appends to the existing assistant row rather than inserting a new
 * message — so this cannot pass on an ordinary first turn.
 */
const titled: { userText: string }[] = [];
vi.mock("@/lib/chat/title", () => ({
  generateChatTitle: async (_m: unknown, _p: unknown, userText: string) => {
    titled.push({ userText });
    return "Quarterly supplier report";
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
            { type: "text-delta", id: "1", delta: "Noted." },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 2 } },
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
// Memory is stubbed at the same seams the sibling e2e suites stub, and for the same
// reason: this runs against the shared database and the real vault would leave a
// space, a topic and claims behind for a fixture user.
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractCandidates: async () => {} }));

import { pool } from "../db";
import { runAgentTask, type ClaimedTask } from "../tasks/runner";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "t15-title-user";
const C = "t15-title-chat";
const OPENING = "draft the quarterly supplier report and remind me what we agreed on payment terms";

run("runAgentTask: a chat that opens with an ask still gets auto-titled", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','t15-title@test.local') ON CONFLICT DO NOTHING`, [U]);
    // The placeholder /api/chat writes: a slice of the opening message. What the user
    // is left staring at forever when the title never lands.
    await pool.query(`INSERT INTO chats (id, user_id, title) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [
      C,
      U,
      OPENING.slice(0, 100),
    ]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    // The chat's whole history: the opening message, and the assistant half that
    // suspended on an `ask` and is now the chat's leaf.
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('t15t-u1',$1,'user',$2)`, [C, OPENING]);
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('t15t-a1',$1,'t15t-u1','assistant','',$2::jsonb)`,
      [C, JSON.stringify({
        status: "awaiting_answer",
        parts: [{ type: "text", text: "Which quarter did you mean?" }],
      })],
    );
    await pool.query(`UPDATE chats SET active_leaf_id='t15t-a1' WHERE id=$1`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id=$1)`, [C]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("titles it from the chat's opening message, not from the continuation's empty turn text", async () => {
    // Written already-running rather than enqueued and claimed: the dev stack's own
    // worker polls this same database and would claim a `queued` row out from under
    // this suite. `uiMessages: []` is what an ask continuation really carries — the
    // user's answer rides `resumeMessages` and is not a chat message at all.
    const { rows } = await pool.query<ClaimedTask>(
      `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload)
       VALUES ('t15t-task',$1,$2,'running','w-t15t', now() + interval '300 seconds', $3::jsonb)
       RETURNING *`,
      [C, U, JSON.stringify({ uiMessages: [], resumeMessageId: "t15t-a1" })],
    );
    await runAgentTask(rows[0], "w-t15t");
    // Titling is fire-and-forget, so wait on the LAST thing it does — the write —
    // rather than on the first. Waiting for the generator to be called leaves the
    // update still in flight, and under a loaded suite that gap is wide enough to read
    // the placeholder back and call it a failure.
    let stored = "";
    for (let i = 0; i < 200 && stored !== "Quarterly supplier report"; i++) {
      const c = await pool.query<{ title: string }>(`SELECT title FROM chats WHERE id=$1`, [C]);
      stored = c.rows[0].title;
      if (stored !== "Quarterly supplier report") await new Promise((r) => setTimeout(r, 50));
    }

    const t = await pool.query(`SELECT status FROM tasks WHERE id='t15t-task'`);
    expect(t.rows[0].status).toBe("completed");

    // Control — this really was a continuation. The run appended to the existing
    // assistant row instead of inserting one, so the history is still two messages
    // and the suspended row is the one that now carries the reply. Without this the
    // assertions below could pass on an ordinary first turn, which is the case that
    // was never broken.
    const msgs = await pool.query<{ id: string; content: string }>(
      `SELECT id, content FROM messages WHERE chat_id=$1 ORDER BY created_at`,
      [C],
    );
    expect(msgs.rows.map((m) => m.id)).toEqual(["t15t-u1", "t15t-a1"]);
    expect(msgs.rows[1].content).toContain("Noted.");

    // The finding: the chat is titled, from what it opened with.
    expect(titled).toEqual([{ userText: OPENING }]);
    expect(stored).toBe("Quarterly supplier report");
  }, 30_000);
});
