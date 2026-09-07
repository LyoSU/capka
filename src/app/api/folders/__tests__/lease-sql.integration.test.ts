import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { liveLeaseSql, heldByOtherSql } from "@/lib/folders/lease";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... vitest run lease-sql.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/**
 * Both writes a sync makes through the API — the bulk upload and the ancestor swap —
 * fence on these predicates, and what they actually MEAN is decided by Postgres:
 * jsonb key access on a possibly-absent column, a text-to-timestamptz cast, and an
 * untyped NULL bound into `IS DISTINCT FROM`. A mocked pool can only check that the
 * string was sent — it evaluates its own idea of the condition — so the semantics
 * are pinned here against a real database.
 */
const U = "lease-sql-user";
const FID = "lease-sql-folder";

run("the lease predicates", () => {
  let query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    query = (sql, params) => pool.query(sql, params);
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'L','lease-sql@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`DELETE FROM attached_folders WHERE id = $1`, [FID]);
    await pool.query(
      `INSERT INTO attached_folders (id, user_id, session_key, kind, name) VALUES ($1,$2,'sk-int','pc','docs')`,
      [FID, U],
    );
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM attached_folders WHERE id = $1`, [FID]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  /** Set the row's lease to `token`, expiring `minutes` from now (negative = past). */
  async function setLease(token: string | null, minutes = 10) {
    await query(
      token === null
        ? `UPDATE attached_folders SET sync_lease = NULL WHERE id = $1`
        : `UPDATE attached_folders
              SET sync_lease = jsonb_build_object('token', $2::text, 'expiresAt', to_char(now() + ($3 || ' minutes')::interval, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
            WHERE id = $1`,
      token === null ? [FID] : [FID, token, String(minutes)],
    );
  }

  const holds = async (token: string) =>
    (await query(`SELECT 1 FROM attached_folders WHERE id = $1 AND ${liveLeaseSql(2)}`, [FID, token])).rows.length === 1;

  it("matches the holder of a live lease", async () => {
    await setLease("t1");
    expect(await holds("t1")).toBe(true);
  });

  it("refuses a token that is not the one on the row", async () => {
    await setLease("t1");
    expect(await holds("t2")).toBe(false);
  });

  // The point of the expiry half: the token still matches, but the run it belongs to
  // has been superseded whether or not anyone has claimed the folder since.
  it("refuses the right token on a lease that has expired", async () => {
    await setLease("t1", -1);
    expect(await holds("t1")).toBe(false);
  });

  // A NULL column must not throw and must not match — `sync_lease->>'token'` is NULL
  // there, and NULL = 't1' is NULL, which is not true.
  it("refuses any token when the row holds no lease at all", async () => {
    await setLease(null);
    expect(await holds("t1")).toBe(false);
  });

  // The upload fence asks the opposite question — "is this folder somebody else's
  // right now?" — because a request that names NO token has to be refused too, and
  // that arrives as NULL. `=` and `<>` both answer NULL for it, which is not true, so
  // either would have waved an unaccompanied write through.
  const heldByOther = async (token: string | null) =>
    (await query(`SELECT 1 FROM attached_folders WHERE id = $1 AND ${heldByOtherSql(2)}`, [FID, token])).rows.length === 1;

  it("treats a request that names no token as not the holder", async () => {
    await setLease("t1");
    expect(await heldByOther(null)).toBe(true);
  });

  it("lets the holder through", async () => {
    await setLease("t1");
    expect(await heldByOther("t1")).toBe(false);
  });

  it("blocks a different token", async () => {
    await setLease("t1");
    expect(await heldByOther("t2")).toBe(true);
  });

  // Nobody's folder: an expired lease and no lease both leave it free, even for a
  // request that names nothing. This is what keeps the one-shot fallback import and
  // any other leaseless caller working.
  it("blocks nobody once the lease has expired", async () => {
    await setLease("t1", -1);
    expect(await heldByOther(null)).toBe(false);
  });

  it("blocks nobody when the row holds no lease", async () => {
    await setLease(null);
    expect(await heldByOther(null)).toBe(false);
  });
});
