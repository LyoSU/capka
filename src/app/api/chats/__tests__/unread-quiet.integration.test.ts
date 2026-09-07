import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run unread-quiet.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "unread-quiet-test-user";

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});

type Row = { id: string; unread: boolean };

/**
 * A quiet automation run must not light the sidebar's unread dot.
 *
 * That badge is the web's half of the notification the Telegram sink already
 * withholds, so leaving it on would make "tell me only when there is something
 * to say" false on the surface the user actually looks at all day.
 */
run("GET /api/chats unread vs quiet replies", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1,'Q','unread-quiet@test.local') ON CONFLICT (id) DO NOTHING`,
      [U],
    );
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  beforeEach(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
    requireSession.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
  });

  /** A never-opened chat (last_read_at NULL), so every assistant reply in it is
   *  newer than the read mark and only the metadata decides the outcome. */
  async function chat(id: string) {
    const { pool } = await import("@/lib/db");
    await pool.query(`INSERT INTO chats (id, user_id, title) VALUES ($1,$2,$1)`, [id, U]);
  }

  async function reply(id: string, chatId: string, metadata: unknown) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','x',$3)`,
      [id, chatId, JSON.stringify(metadata)],
    );
  }

  async function list(): Promise<Row[]> {
    const { GET } = await import("../route");
    const res = await GET(new Request("http://x/api/chats"));
    expect(res.status).toBe(200);
    return (await res.json()) as Row[];
  }

  it("an ordinary reply marks the chat unread; a quiet one does not", async () => {
    await chat("uq-normal");
    await reply("uq-m1", "uq-normal", { status: "completed" });
    await chat("uq-quiet");
    await reply("uq-m2", "uq-quiet", { status: "completed", quiet: { reason: "Nothing changed." } });

    const byId = new Map((await list()).map((r) => [r.id, r.unread]));
    expect(byId.get("uq-normal")).toBe(true);
    expect(byId.get("uq-quiet")).toBe(false);
  });

  it("one ordinary reply after a quiet one still marks the chat unread", async () => {
    // The quiet rows are invisible to the badge, not to the predicate as a whole:
    // a monitor that finally has something to say must reach the user.
    await chat("uq-mixed");
    await reply("uq-m3", "uq-mixed", { status: "completed", quiet: { reason: "Nothing changed." } });
    await reply("uq-m4", "uq-mixed", { status: "completed" });

    const byId = new Map((await list()).map((r) => [r.id, r.unread]));
    expect(byId.get("uq-mixed")).toBe(true);
  });
});
