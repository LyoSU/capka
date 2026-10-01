import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@/lib/db";
import { resolveActiveChat } from "../bot";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run active-leaf-status.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

// A Telegram message chained onto a leaf still waiting on a card settles that card, and
// the bot learns the leaf's status from a hand-written correlated subquery in the same
// select that loads the chat. ingest-hold.test.ts answers that select with a canned row,
// so a typo in the subquery (the column, the JSON key) would send every Telegram message
// down the plain-write path with every unit test green. This runs the real statement.
const U = "tg-leaf-user";
const TG = 990_100_001;
const LINK = "tg-leaf-link";
const chat = (suffix: string) => `tg-leaf-chat-${suffix}`;

async function seedChat(suffix: string, leaf?: Record<string, unknown>) {
  await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2)`, [chat(suffix), U]);
  if (!leaf) return;
  const id = `tg-leaf-msg-${suffix}`;
  await pool.query(`INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','',$3::jsonb)`, [id, chat(suffix), JSON.stringify(leaf)]);
  await pool.query(`UPDATE chats SET active_leaf_id = $1 WHERE id = $2`, [id, chat(suffix)]);
}
const link = (activeChatId: string | null) => ({ id: LINK, userId: U, activeChatId });

run("resolveActiveChat: the leaf's status", () => {
  const clean = async () => {
    await pool.query(`DELETE FROM telegram_links WHERE id = $1`, [LINK]);
    await pool.query(`UPDATE chats SET active_leaf_id = NULL WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = $1)`, [U]);
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
  };
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'T','tg-leaf@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await clean();
    await pool.query(`INSERT INTO telegram_links (id, user_id, telegram_user_id) VALUES ($1,$2,$3)`, [LINK, U, TG]);
    await seedChat("await", { status: "awaiting_approval", parts: [] });
    await seedChat("answer", { status: "awaiting_answer", parts: [] });
    await seedChat("done", { status: "completed", parts: [] });
    await seedChat("empty");
  });
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  it("reads the status of the pinned chat's active leaf", async () => {
    expect(await resolveActiveChat(link(chat("await")), "hi")).toMatchObject({ id: chat("await"), leafStatus: "awaiting_approval" });
    expect(await resolveActiveChat(link(chat("answer")), "hi")).toMatchObject({ id: chat("answer"), leafStatus: "awaiting_answer" });
    expect(await resolveActiveChat(link(chat("done")), "hi")).toMatchObject({ id: chat("done"), leafStatus: "completed" });
  });

  it("reads null for a chat with no leaf yet", async () => {
    expect(await resolveActiveChat(link(chat("empty")), "hi")).toMatchObject({ id: chat("empty"), leafStatus: null });
  });

  it("reads null for a chat it creates, through the locking branch too", async () => {
    const created = await resolveActiveChat(link(null), "first message");
    expect(created).toMatchObject({ title: "first message", leafStatus: null });
    const [pinned] = (await pool.query(`SELECT active_chat_id FROM telegram_links WHERE id = $1`, [LINK])).rows;
    expect(pinned.active_chat_id).toBe(created.id);
    // The next message resolves that same chat, not a second one.
    expect((await resolveActiveChat(link(created.id), "again")).id).toBe(created.id);
  });
});
