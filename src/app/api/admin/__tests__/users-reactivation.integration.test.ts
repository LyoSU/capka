import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run users-reactivation.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "reactivation-test-user";
const ADMIN = "reactivation-test-admin";

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAdmin };
});
vi.mock("@/lib/governance/audit", () => ({ audit: vi.fn() }));

// Nothing blocks a suspended account from signing in, so a session can be created
// while it is suspended; reactivation must not hand that session the account.
run("PUT /api/admin/users status lifecycle", () => {
  const put = async (status: string) => {
    const { PUT } = await import("@/app/api/admin/users/route");
    const res = await PUT(new Request("http://localhost/api/admin/users", { method: "PUT", body: JSON.stringify({ userId: U, status }) }));
    expect(res.status).toBe(200);
  };
  const count = async (table: "session" | "link_codes") => {
    const { pool } = await import("@/lib/db");
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [U]);
    return r.rows[0].n as number;
  };
  const seedSession = async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO "session" (id, user_id, token, expires_at) VALUES ($1,$2,$3,now() + interval '1 day')`,
      [`reactivation-s-${Math.random()}`, U, `tok-${Math.random()}`],
    );
  };
  const seedCode = async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`INSERT INTO link_codes (code, user_id, expires_at) VALUES ($1,$2,now() + interval '5 minutes')`, [`RC${Math.random()}`, U]);
  };

  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'R','reactivation@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
  });
  beforeEach(async () => {
    const { pool } = await import("@/lib/db");
    requireAdmin.mockResolvedValue({ userId: ADMIN, role: "admin", status: "active" });
    await pool.query(`DELETE FROM "session" WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM link_codes WHERE user_id = $1`, [U]);
    await pool.query(`UPDATE "user" SET status = 'active' WHERE id = $1`, [U]);
  });
  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  it("a session created while suspended does not survive reactivation", async () => {
    await put("suspended");
    await seedSession();
    expect(await count("session")).toBe(1);
    await put("active");
    expect(await count("session")).toBe(0);
  });

  it("a pending link code does not survive suspension or reactivation", async () => {
    await seedCode();
    await put("suspended");
    expect(await count("link_codes")).toBe(0);
    await seedCode();
    await put("active");
    expect(await count("link_codes")).toBe(0);
  });

  it("approving a pending signup keeps its session", async () => {
    await put("pending");
    await seedSession();
    await put("active");
    expect(await count("session")).toBe(1);
  });
});
