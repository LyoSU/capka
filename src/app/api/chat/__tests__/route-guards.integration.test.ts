import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run route-guards.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "route-guards-test-user";
const OTHER = "route-guards-other-user";

const { requireRole, resolveUserModelInfo, reserveBudget, releaseHold, enqueueTask, publishTaskEvent } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveUserModelInfo: vi.fn(),
  reserveBudget: vi.fn(),
  releaseHold: vi.fn(),
  enqueueTask: vi.fn(),
  publishTaskEvent: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});
vi.mock("@/lib/providers/resolve", () => ({ resolveUserModelInfo }));
vi.mock("@/lib/billing/limits", () => ({ reserveBudget, releaseHold }));
// No task row is written: a live worker on the same database would claim it.
vi.mock("@/lib/tasks/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tasks/queue")>()),
  enqueueTask,
}));
vi.mock("@/lib/rate-limit", () => ({ take: () => ({ ok: true }) }));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent }));

import { pool } from "@/lib/db";
import { POST } from "@/app/api/chat/route";

/**
 * The guards on POST /api/chat that are only as good as the SQL behind them: which
 * row a client-chosen id or parent id resolves to, and what the route leaves
 * written when it refuses. A fake db that ignores `.where()` cannot tell a row in
 * this chat from one in someone else's.
 */
run("POST /api/chat guards against the real tables", () => {
  const send = (body: unknown) =>
    POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  const leafOf = async (chatId: string) =>
    (await q(`SELECT active_leaf_id FROM chats WHERE id = $1`, [chatId]))[0]?.active_leaf_id;

  beforeAll(async () => {
    for (const [id, email] of [[U, "route-guards@test.local"], [OTHER, "route-guards-other@test.local"]]) {
      await q(`INSERT INTO "user" (id, name, email) VALUES ($1,'T',$2) ON CONFLICT (id) DO NOTHING`, [id, email]);
    }
  });

  afterAll(async () => {
    await q(`DELETE FROM chats WHERE user_id = ANY($1)`, [[U, OTHER]]);
    await q(`DELETE FROM "user" WHERE id = ANY($1)`, [[U, OTHER]]);
  });

  beforeEach(async () => {
    await q(`DELETE FROM chats WHERE user_id = ANY($1)`, [[U, OTHER]]);
    // Someone else's chat, whose message ids a tampered client might name.
    await q(`INSERT INTO chats (id, user_id, title) VALUES ('rg-other', $1, 'Theirs')`, [OTHER]);
    await q(
      `INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES ('rg-foreign', 'rg-other', NULL, 'user', 'their words')`,
      [],
    );
    await q(`UPDATE chats SET active_leaf_id = 'rg-foreign' WHERE id = 'rg-other'`, []);
    // Ours: an imported shape where the last reply answers another reply (its
    // user turn was dropped on import) — u1 → a1 → a2.
    await q(`INSERT INTO chats (id, user_id, title) VALUES ('rg-mine', $1, 'Mine')`, [U]);
    await q(
      `INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES
        ('rg-u1', 'rg-mine', NULL, 'user', 'hi'),
        ('rg-a1', 'rg-mine', 'rg-u1', 'assistant', 'hello'),
        ('rg-a2', 'rg-mine', 'rg-a1', 'assistant', 'and more')`,
      [],
    );
    await q(`UPDATE chats SET active_leaf_id = 'rg-a2' WHERE id = 'rg-mine'`, []);

    requireRole.mockReset().mockResolvedValue({ userId: U, status: "active", role: "user" });
    resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: false, modelId: "m1", provider: "openai" });
    reserveBudget.mockReset().mockResolvedValue({ allowed: true });
    releaseHold.mockReset().mockResolvedValue(undefined);
    enqueueTask.mockReset().mockResolvedValue({ id: "t1", created: true });
    publishTaskEvent.mockReset().mockResolvedValue(undefined);
  });

  it("refuses a message id that is already another chat's row, and moves nothing", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "mine now?", userMessageId: "rg-foreign" });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("MESSAGE_ID_IN_USE");
    expect(await leafOf("rg-mine")).toBe("rg-a2");
    expect(await q(`SELECT chat_id, content FROM messages WHERE id = 'rg-foreign'`, [])).toEqual([
      { chat_id: "rg-other", content: "their words" },
    ]);
    expect(enqueueTask).not.toHaveBeenCalled();
    // The hold taken for this send is given back.
    expect(releaseHold).toHaveBeenCalledWith(reserveBudget.mock.calls[0][0].taskId);
  });

  it("refuses a message id that is a reply in this very chat", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "again", userMessageId: "rg-a1" });

    expect(res.status).toBe(409);
    expect(await leafOf("rg-mine")).toBe("rg-a2");
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("still takes the same send twice, as one message", async () => {
    const body = { chatId: "rg-mine", userMessage: "next", userMessageId: "rg-u2" };

    expect((await send(body)).status).toBe(200);
    expect((await send(body)).status).toBe(200);

    expect(await q(`SELECT count(*)::int AS n FROM messages WHERE id = 'rg-u2'`, [])).toEqual([{ n: 1 }]);
    expect(await leafOf("rg-mine")).toBe("rg-u2");
    expect(enqueueTask.mock.calls.map((c) => c[0].payload.replyParentId)).toEqual(["rg-u2", "rg-u2"]);
    // Nothing on the path changed but the leaf: no tab is told to reload.
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  it("refuses an empty send to a new chat without writing the chat", async () => {
    const res = await send({ chatId: "rg-new", userMessage: "" });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOTHING_TO_SEND");
    expect(await q(`SELECT id FROM chats WHERE id = 'rg-new'`, [])).toEqual([]);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("refuses a parent from another chat before writing a new chat", async () => {
    const res = await send({ chatId: "rg-new", userMessage: "hi", parentId: "rg-foreign" });

    expect(res.status).toBe(409);
    expect(await q(`SELECT id FROM chats WHERE id = 'rg-new'`, [])).toEqual([]);
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  it("refuses another chat's message id as a new chat's first message without writing the chat", async () => {
    const res = await send({ chatId: "rg-new", userMessage: "hi", userMessageId: "rg-foreign" });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("MESSAGE_ID_IN_USE");
    expect(await q(`SELECT id FROM chats WHERE id = 'rg-new'`, [])).toEqual([]);
    expect(await q(`SELECT chat_id FROM messages WHERE id = 'rg-foreign'`, [])).toEqual([{ chat_id: "rg-other" }]);
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  it("still starts a new chat with a fresh message id", async () => {
    const res = await send({ chatId: "rg-new", userMessage: "hi", userMessageId: "rg-new-u1" });

    expect(res.status).toBe(200);
    expect(await leafOf("rg-new")).toBe("rg-new-u1");
  });

  it("says a reply that answers another reply can't be regenerated", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "", parentId: "rg-a1" });

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CANNOT_REGENERATE");
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  // A stale tab, or a client that never blocked its composer, sends past a reply whose
  // card still waits. The card is settled with the message, so it stops being live.
  it("settles the card of a waiting reply it sends past, in the same write", async () => {
    await q(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('rg-a3', 'rg-mine', 'rg-a2', 'assistant', '', $1::jsonb)`,
      [JSON.stringify({ status: "awaiting_approval", parts: [{ type: "tool-call", id: "c1", name: "manage", input: {}, approval: { id: "ap1" } }] })],
    );
    await q(`UPDATE chats SET active_leaf_id = 'rg-a3' WHERE id = 'rg-mine'`, []);

    expect((await send({ chatId: "rg-mine", userMessage: "never mind", userMessageId: "rg-u3" })).status).toBe(200);

    const [{ metadata }] = await q(`SELECT metadata FROM messages WHERE id = 'rg-a3'`, []);
    expect(metadata).toMatchObject({ status: "completed", parts: [{ id: "c1", approval: { id: "ap1", approved: false } }] });
    expect(await leafOf("rg-mine")).toBe("rg-u3");
    expect(enqueueTask.mock.calls[0][0].payload.replyParentId).toBe("rg-u3");
    // Open tabs still hold the reply with its card live; they reload into the settled one.
    expect(publishTaskEvent).toHaveBeenCalledWith(U, { type: "new_message", chatId: "rg-mine" });
  });

  it("leaves the card waiting when the message it would have gone past is refused", async () => {
    await q(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('rg-a3', 'rg-mine', 'rg-a2', 'assistant', '', $1::jsonb)`,
      [JSON.stringify({ status: "awaiting_answer", parts: [{ type: "tool-call", id: "q1", name: "ask", input: {}, answer: { form: { fields: [{ id: "f", label: "F", kind: "text" }] } } }] })],
    );
    await q(`UPDATE chats SET active_leaf_id = 'rg-a3' WHERE id = 'rg-mine'`, []);

    expect((await send({ chatId: "rg-mine", userMessage: "skip it", userMessageId: "rg-foreign" })).status).toBe(409);

    const [{ metadata }] = await q(`SELECT metadata FROM messages WHERE id = 'rg-a3'`, []);
    expect(metadata.status).toBe("awaiting_answer");
    expect(await leafOf("rg-mine")).toBe("rg-a3");
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  // The reply was compacted after this tab loaded: its checkpoint now sits directly under
  // it, with the message that followed below that. The tab still names the reply when
  // editing that message, and the edit belongs beside the original, under the checkpoint.
  it("puts an edit from a tab that missed the compaction under the reply's checkpoint", async () => {
    await q(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES
        ('rg-cp', 'rg-mine', 'rg-a2', 'assistant', '', $1::jsonb),
        ('rg-u2', 'rg-mine', 'rg-cp', 'user', 'next', NULL)`,
      [JSON.stringify({ status: "completed", compaction: { summary: "s", summarizedUpTo: "rg-a2" } })],
    );
    await q(`UPDATE chats SET active_leaf_id = 'rg-u2' WHERE id = 'rg-mine'`, []);

    expect((await send({ chatId: "rg-mine", userMessage: "next, edited", userMessageId: "rg-u2b", parentId: "rg-a2" })).status).toBe(200);

    expect(await q(`SELECT parent_id FROM messages WHERE id = 'rg-u2b'`, [])).toEqual([{ parent_id: "rg-cp" }]);
    expect(await leafOf("rg-mine")).toBe("rg-u2b");
    expect(enqueueTask.mock.calls[0][0].payload.replyParentId).toBe("rg-u2b");

    // Control: a reply with no checkpoint under it stays the parent it was named as.
    expect((await send({ chatId: "rg-mine", userMessage: "and more, edited", userMessageId: "rg-a2b", parentId: "rg-a1" })).status).toBe(200);
    expect(await q(`SELECT parent_id FROM messages WHERE id = 'rg-a2b'`, [])).toEqual([{ parent_id: "rg-a1" }]);
  });

  it("still regenerates a reply to a user message", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "", parentId: "rg-u1" });

    expect(res.status).toBe(200);
    expect(enqueueTask.mock.calls[0][0].payload.replyParentId).toBe("rg-u1");
  });
});
