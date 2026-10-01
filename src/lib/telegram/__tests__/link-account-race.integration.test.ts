import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run link-account-race.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "link-race-test-user";
const TG = 987654321;

vi.mock("@/lib/settings", () => ({ getSetting: vi.fn(async () => "123:TESTTOKEN"), setSetting: vi.fn(async () => {}) }));

const commands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
vi.mock("grammy", () => {
  class Bot {
    api = { deleteWebhook: vi.fn(async () => {}), setMyCommands: vi.fn(async () => {}) };
    on() { return this; }
    command(name: string, h: (ctx: unknown) => Promise<unknown>) { commands[name] = h; return this; }
    callbackQuery() { return this; }
    catch() { return this; }
    async start() {}
    async stop() {}
  }
  class InlineKeyboard {
    url() { return this; }
    text() { return this; }
    row() { return this; }
  }
  return { Bot, InlineKeyboard };
});

// A suspension that commits while /link is mid-flight must not leave a Telegram
// sign-in on the suspended account.
run("telegram /link vs a concurrent suspension", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`INSERT INTO "user" (id, name, email, status) VALUES ($1,'L','link-race@test.local','active') ON CONFLICT (id) DO UPDATE SET status = 'active'`, [U]);
    await pool.query(`INSERT INTO link_codes (code, user_id, expires_at) VALUES ('RACECODE', $1, now() + interval '5 minutes')`, [U]);
    const { getBot } = await import("../bot");
    await getBot();
  });
  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  it("links nothing when the suspension commits while the link is running", async () => {
    const { pool } = await import("@/lib/db");
    const admin = await pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(`UPDATE "user" SET status = 'suspended' WHERE id = $1`, [U]);
      const ctx = { from: { id: TG, language_code: "en" }, chat: { id: TG }, match: "RACECODE", replyWithRichMessage: vi.fn(async () => ({})) };
      const linking = commands.link(ctx);
      await new Promise((r) => setTimeout(r, 400));
      await admin.query("COMMIT");
      await linking;
      const links = await pool.query(`SELECT 1 FROM telegram_links WHERE user_id = $1`, [U]);
      const accts = await pool.query(`SELECT 1 FROM account WHERE user_id = $1 AND provider_id = 'telegram'`, [U]);
      expect(links.rowCount).toBe(0);
      expect(accts.rowCount).toBe(0);
    } finally {
      admin.release();
    }
  });
});
