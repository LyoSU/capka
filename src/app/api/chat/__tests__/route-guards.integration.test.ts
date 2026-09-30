import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run route-guards.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "route-guards-test-user";
const OTHER = "route-guards-other-user";

const { requireRole, resolveUserModelInfo, reserveBudget, releaseHold, enqueueTask } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveUserModelInfo: vi.fn(),
  reserveBudget: vi.fn(),
  releaseHold: vi.fn(),
  enqueueTask: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});
vi.mock("@/lib/providers/resolve", () => ({ resolveUserModelInfo }));
vi.mock("@/lib/billing/limits", () => ({ reserveBudget, releaseHold }));
// No task row is written: a live worker on the same database would claim it.
vi.mock("@/lib/tasks/queue", () => ({ enqueueTask }));
vi.mock("@/lib/rate-limit", () => ({ take: () => ({ ok: true }) }));

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
  });

  it("refuses a message id that is already another chat's row, and moves nothing", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "mine now?", userMessageId: "rg-foreign" });

    expect(res.status).toBe(409);
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
  });

  it("refuses an empty send to a new chat without writing the chat", async () => {
    const res = await send({ chatId: "rg-new", userMessage: "" });

    expect(res.status).toBe(400);
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

  it("says a reply that answers another reply can't be regenerated", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "", parentId: "rg-a1" });

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CANNOT_REGENERATE");
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("still regenerates a reply to a user message", async () => {
    const res = await send({ chatId: "rg-mine", userMessage: "", parentId: "rg-u1" });

    expect(res.status).toBe(200);
    expect(enqueueTask.mock.calls[0][0].payload.replyParentId).toBe("rg-u1");
  });
});
