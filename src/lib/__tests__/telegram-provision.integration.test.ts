import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "../db";
import { provisionTelegramUser } from "../auth";
import { getSetting, setSetting } from "../settings";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run telegram-provision.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

// Test ids in a high range that won't collide with real Telegram accounts.
const IDS = [990_000_001, 990_000_002, 990_000_003, 990_000_004, 990_000_005, 990_000_006];

async function cleanup() {
  await pool.query(`DELETE FROM account WHERE provider_id = 'telegram' AND account_id = ANY($1)`, [IDS.map(String)]);
  await pool.query(`DELETE FROM telegram_links WHERE telegram_user_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM "user" WHERE email LIKE 'tg99000%@telegram.local'`);
}

async function accountCount(id: number) {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM account WHERE provider_id = 'telegram' AND account_id = $1`,
    [String(id)],
  );
  return Number(rows[0].n);
}
async function linkCount(id: number) {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM telegram_links WHERE telegram_user_id = $1`,
    [id],
  );
  return Number(rows[0].n);
}

run("provisionTelegramUser", () => {
  let origMode: string | null;
  let origSetup: string | null;

  beforeAll(async () => {
    origMode = await getSetting("registration_mode");
    origSetup = await getSetting("setup_complete");
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    if (origMode !== null) await setSetting("registration_mode", origMode);
    if (origSetup !== null) await setSetting("setup_complete", origSetup);
  });
  beforeEach(async () => {
    await cleanup();
    await setSetting("setup_complete", "true");
  });

  it("open: creates one active user with exactly one account + link, and is idempotent", async () => {
    await setSetting("registration_mode", "open");
    const id = IDS[0];
    const first = await provisionTelegramUser(id, { name: "Alice", username: "alice" });
    expect(first).toMatchObject({ status: "active" });
    if ("refused" in first) throw new Error("unexpected refusal");
    expect(await accountCount(id)).toBe(1);
    expect(await linkCount(id)).toBe(1);

    // Second contact resolves the SAME user, never a duplicate account.
    const second = await provisionTelegramUser(id, { name: "Alice", username: "alice2" });
    expect(second).toEqual({ userId: first.userId, status: "active" });
    expect(await accountCount(id)).toBe(1);
    expect(await linkCount(id)).toBe(1);
  });

  it("approval: parks the new account as pending", async () => {
    await setSetting("registration_mode", "approval");
    const r = await provisionTelegramUser(IDS[1], { name: "Bob", username: null });
    expect(r).toMatchObject({ status: "pending" });
  });

  it("closed: refuses and creates nothing", async () => {
    await setSetting("registration_mode", "closed");
    const id = IDS[2];
    const r = await provisionTelegramUser(id, { name: "Carol", username: null });
    expect(r).toEqual({ refused: "closed" });
    expect(await accountCount(id)).toBe(0);
    expect(await linkCount(id)).toBe(0);
  });

  it("setup incomplete: refuses even in open mode", async () => {
    await setSetting("setup_complete", "false");
    await setSetting("registration_mode", "open");
    const id = IDS[3];
    const r = await provisionTelegramUser(id, { name: "Dave", username: null });
    expect(r).toEqual({ refused: "setup_incomplete" });
    expect(await accountCount(id)).toBe(0);
  });

  it("concurrent first contacts create exactly one user/account/link (advisory lock)", async () => {
    await setSetting("registration_mode", "open");
    const id = IDS[4];
    const [a, b] = await Promise.all([
      provisionTelegramUser(id, { name: "Eve", username: "eve" }),
      provisionTelegramUser(id, { name: "Eve", username: "eve" }),
    ]);
    if ("refused" in a || "refused" in b) throw new Error("unexpected refusal under race");
    expect(a.userId).toBe(b.userId);
    expect(await accountCount(id)).toBe(1);
    expect(await linkCount(id)).toBe(1);
  });

  it("heals an orphaned user (email row exists, no account) without duplicating it, preserving its status", async () => {
    await setSetting("registration_mode", "open");
    const id = IDS[5];
    const email = `tg${id}@telegram.local`;
    const orphanId = `heal-orphan-${id}`;
    // A user row with the synthetic email but NO account/link (a half-finished
    // signup). Park it as pending to prove provisioning reports the ROW's status,
    // not the fresh "open → active" decision.
    await pool.query(`INSERT INTO "user" (id, name, email, role, status) VALUES ($1, 'Orphan', $2, 'user', 'pending')`, [orphanId, email]);
    expect(await accountCount(id)).toBe(0);

    const r = await provisionTelegramUser(id, { name: "Orphan", username: null });
    expect(r).toEqual({ userId: orphanId, status: "pending" });
    // No duplicate user minted for the same synthetic email; account + link attached.
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "user" WHERE email = $1`, [email]);
    expect(Number(rows[0].n)).toBe(1);
    expect(await accountCount(id)).toBe(1);
    expect(await linkCount(id)).toBe(1);
  });

  it("reattaches an orphaned link to the existing account without duplicating the user", async () => {
    await setSetting("registration_mode", "open");
    const id = IDS[0];
    const first = await provisionTelegramUser(id, { name: "Alice", username: "alice" });
    if ("refused" in first) throw new Error("unexpected refusal");
    // Simulate an orphaned link (account row survives, link dropped).
    await pool.query(`DELETE FROM telegram_links WHERE telegram_user_id = $1`, [id]);
    expect(await linkCount(id)).toBe(0);

    const again = await provisionTelegramUser(id, { name: "Alice", username: "alice" });
    expect(again).toEqual({ userId: first.userId, status: "active" });
    expect(await accountCount(id)).toBe(1);
    expect(await linkCount(id)).toBe(1);
  });
});
