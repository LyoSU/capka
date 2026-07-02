import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "../db";
import { reserveBudget, releaseHold } from "../billing/limits";
import { reconcileUsage } from "../usage";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run billing.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "btest-user";
const TIER = "btest-tier";
const MODEL = "btest/priced-model";

run("shared-key budget", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'B','b@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    // A priced model so reserveBudget can estimate a non-zero turn cost (an
    // unpriced model is allowed through with a zero hold, so the cap wouldn't bite).
    await pool.query(
      `INSERT INTO models (id, source, display_name, input_price, output_price)
       VALUES ($1,'test','Priced', 0.000001, 0.000002)
       ON CONFLICT (id) DO UPDATE SET input_price = excluded.input_price`,
      [MODEL],
    );
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`UPDATE "user" SET tier_id = NULL WHERE id = $1`, [U]);
    await pool.query(`DELETE FROM tiers WHERE id = $1`, [TIER]);
    await pool.query(`DELETE FROM models WHERE id = $1`, [MODEL]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [U]);
  });

  async function setTier(limit5h: string | null) {
    await pool.query(
      `INSERT INTO tiers (id, name, limit_5h, is_default)
       VALUES ($1,'T',$2,false)
       ON CONFLICT (id) DO UPDATE SET limit_5h = excluded.limit_5h`,
      [TIER, limit5h],
    );
    await pool.query(`UPDATE "user" SET tier_id = $1 WHERE id = $2`, [TIER, U]);
  }

  // H8: a configured cap of 0 is a hard deny — it must NOT be read as "unlimited".
  it("a tier cap of 0 blocks spend (0 is a hard deny, not unlimited)", async () => {
    await setTier("0");
    const r = await reserveBudget({
      userId: U, taskId: "bt-zero", onSharedKey: true, modelId: MODEL,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("budget");
    expect(r.window).toBe("h5");
    // No hold written for a denied reserve.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM usage WHERE task_id = 'bt-zero'`);
    expect(rows[0].n).toBe(0);
  });

  // A null (unset) cap is genuinely unlimited — the 0 case above must not regress this.
  it("an unset (null) cap allows spend and writes a pending hold", async () => {
    await setTier(null);
    const r = await reserveBudget({
      userId: U, taskId: "bt-null", onSharedKey: true, modelId: MODEL,
    });
    expect(r.allowed).toBe(true);
    const { rows } = await pool.query<{ pending: boolean }>(
      `SELECT pending FROM usage WHERE task_id = 'bt-null'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].pending).toBe(true);
    await releaseHold("bt-null");
  });

  // H6 billing effect: an aborted/failed turn that still spent real tokens settles
  // its hold to the REAL figures (pending → committed) instead of discarding it.
  it("reconcileUsage settles a pending hold to real spend in place", async () => {
    await setTier(null);
    const reserved = await reserveBudget({
      userId: U, taskId: "bt-recon", onSharedKey: true, modelId: MODEL,
    });
    expect(reserved.allowed).toBe(true);

    await reconcileUsage({
      taskId: "bt-recon", userId: U, provider: "shared", model: MODEL,
      onSharedKey: true,
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
      costUsd: 0.0042,
    });

    // The same row was updated in place — still ONE row, now settled (pending=false)
    // carrying the real figures, not the estimate.
    const { rows } = await pool.query<{ pending: boolean; cost_usd: string; input_tokens: number }>(
      `SELECT pending, cost_usd, input_tokens FROM usage WHERE task_id = 'bt-recon'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].pending).toBe(false);
    expect(rows[0].input_tokens).toBe(1000);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0042, 6);

    // releaseHold (the runner's finally) now finds nothing pending to cancel.
    await releaseHold("bt-recon");
    const after = await pool.query<{ pending: boolean }>(
      `SELECT pending FROM usage WHERE task_id = 'bt-recon'`,
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].pending).toBe(false);
  });
});
