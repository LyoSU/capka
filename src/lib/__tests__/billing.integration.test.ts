import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "../db";
import { reserveBudget, releaseHold, getLimitStatus } from "../billing/limits";
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

const MU = "btest-month-user";
const MTIER = "btest-month-tier";

// The month cap is a CALENDAR month (resets on the 1st), not a rolling 30 days —
// a finance department budgets "August", not "the last 30 days".
run("calendar month budget window", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'M','m@test.local') ON CONFLICT (id) DO NOTHING`, [MU]);
    await pool.query(
      `INSERT INTO tiers (id, name, limit_month, is_default) VALUES ($1,'M','10',false)
       ON CONFLICT (id) DO UPDATE SET limit_month = excluded.limit_month`,
      [MTIER],
    );
    await pool.query(`UPDATE "user" SET tier_id = $1 WHERE id = $2`, [MTIER, MU]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [MU]);
    await pool.query(`UPDATE "user" SET tier_id = NULL WHERE id = $1`, [MU]);
    await pool.query(`DELETE FROM tiers WHERE id = $1`, [MTIER]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [MU]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [MU]);
  });

  /** A settled shared-key row of `cost`, dated by a SQL expression. */
  async function spentAt(id: string, cost: string, whenSql: string) {
    await pool.query(
      `INSERT INTO usage (id, user_id, provider, model, cost_usd, on_shared_key, pending, created_at)
       VALUES ($1,$2,'test','btest/m',$3,true,false, ${whenSql})`,
      [id, MU, cost],
    );
  }

  const month = async () => (await getLimitStatus(MU)).windows.find((w) => w.window === "m1")!;

  // Last month's bill must not follow you into this month. Dated one hour before
  // the month boundary, so it is still INSIDE the old rolling-30d window on any
  // day before the 30th — which is exactly what made the old behaviour wrong.
  it("excludes spend from the previous calendar month", async () => {
    await spentAt("bt-prev-month", "7", `date_trunc('month', now()) - interval '1 hour'`);
    const m = await month();
    expect(m.used).toBe(0);
    expect(m.limit).toBe(10);
  });

  it("includes spend from this month", async () => {
    await spentAt("bt-this-month", "7", `date_trunc('month', now()) + interval '1 second'`);
    expect((await month()).used).toBe(7);
  });

  // The query bounds its scan to the widest window. When that bound was a flat
  // `now() - 30 days`, the first hours of a 31-day month fell outside it on the
  // last day of that month — the cap silently under-counted on the worst possible
  // day. The bound must reach back to the month boundary itself.
  it("counts the very first instant of the month", async () => {
    await spentAt("bt-month-start", "7", `date_trunc('month', now())`);
    expect((await month()).used).toBe(7);
  });

  it("blocks a turn once the month cap is reached", async () => {
    await spentAt("bt-month-full", "10", `date_trunc('month', now()) + interval '1 second'`);
    const r = await reserveBudget({ userId: MU, taskId: "bt-month-gate", onSharedKey: true });
    expect(r.allowed).toBe(false);
    expect(r.window).toBe("m1");
  });
});

const CU = "btest-conn-user";
const CFG = "btest-conn-config";

// Which CONNECTION spent the money — two configs of the same provider (two
// LiteLLM proxies, two Azure keys) are indistinguishable by `provider` alone.
run("spend attribution by connection", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'C','c@test.local') ON CONFLICT (id) DO NOTHING`, [CU]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [CU]);
    await pool.query(`DELETE FROM provider_configs WHERE id = $1`, [CFG]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [CU]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [CU]);
    await pool.query(
      `INSERT INTO provider_configs (id, user_id, provider, label) VALUES ($1,$2,'litellm','Proxy A')
       ON CONFLICT (id) DO UPDATE SET label = excluded.label`,
      [CFG, CU],
    );
  });

  const configOf = async (taskId: string) =>
    (await pool.query<{ config_id: string | null }>(`SELECT config_id FROM usage WHERE task_id = $1`, [taskId])).rows;

  // The hold is written before the turn runs; if it never reconciles (crash,
  // released turn) it is the ONLY record of that spend, so it must carry the
  // connection too.
  it("tags the pre-run hold with the connection", async () => {
    const r = await reserveBudget({ userId: CU, taskId: "bt-cfg-hold", onSharedKey: true, configId: CFG });
    expect(r.allowed).toBe(true);
    expect((await configOf("bt-cfg-hold"))[0].config_id).toBe(CFG);
    await releaseHold("bt-cfg-hold");
  });

  it("keeps the connection when the hold settles to real spend", async () => {
    await reserveBudget({ userId: CU, taskId: "bt-cfg-settle", onSharedKey: true, configId: CFG });
    await reconcileUsage({
      taskId: "bt-cfg-settle", userId: CU, provider: "litellm", model: "m", configId: CFG,
      onSharedKey: true, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01,
    });
    const rows = await configOf("bt-cfg-settle");
    expect(rows.length).toBe(1);
    expect(rows[0].config_id).toBe(CFG);
  });

  // Money is history: disconnecting a provider must not erase what it spent.
  it("survives deletion of the connection, unattributed", async () => {
    await reconcileUsage({
      taskId: "bt-cfg-orphan", userId: CU, provider: "litellm", model: "m", configId: CFG,
      onSharedKey: true, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01,
    });
    await pool.query(`DELETE FROM provider_configs WHERE id = $1`, [CFG]);
    const rows = await configOf("bt-cfg-orphan");
    expect(rows.length).toBe(1);
    expect(rows[0].config_id).toBeNull();
  });
});
