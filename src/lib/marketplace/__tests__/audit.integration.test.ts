import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { pool, db } from "@/lib/db";
import { AuditInvariantViolation, applyEventId, insertPluginAudit } from "../audit";
import type { DurablePluginReview } from "../review";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run audit.integration
 *
 * Idempotency and atomicity of the apply journal (§10). Both are properties of
 * `ON CONFLICT` and of transaction rollback, so neither survives being mocked.
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const OP = "audtest-op";
const HASH = "hash-1";

const review = (over: Partial<DurablePluginReview> = {}): DurablePluginReview => ({
  subject: { kind: "upgrade", installId: "i1", marketplaceId: "mk1", pluginName: "plug",
             scope: "system", ownerId: null, targetSha: "a".repeat(40), only: null },
  reviewHash: HASH,
  surface: { schemaVersion: 1, completeness: "derived", connectors: [], skills: [],
             files: { projection: "public", count: 0, bytes: 0, entrypoints: [] } },
  delta: { upstream: [], effective: [], kinds: ["unchanged"], gate: "no_consent" },
  gate: "no_consent",
  observations: { urls: {}, detectedAuth: {}, policy: { blockPrivate: false }, observedAt: "2026-08-14T00:00:00.000Z" },
  notes: [],
  ...over,
});

const cleanup = () => pool.query(`DELETE FROM audit_log WHERE id LIKE $1`, [`plugin-apply:${OP}%`]);
const countOf = async (event: "accepted" | "succeeded" | "failed") => {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE id = $1`, [applyEventId(OP, event)]);
  return Number(rows[0].n);
};

run("plugin apply journal", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("stores the full review once, under `accepted`", async () => {
    await insertPluginAudit(db, { operationId: OP, event: "accepted", actorId: null, review: review(), reviewHash: HASH, targetKey: "plug" });
    const { rows } = await pool.query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_log WHERE id = $1`, [applyEventId(OP, "accepted")]);
    expect(rows[0].action).toBe("plugin.apply_accepted");
    expect(rows[0].detail).toMatchObject({ operationId: OP, reviewHash: HASH, outcome: "pending" });
    expect(rows[0].detail.review).toBeTruthy();
  });

  it("keeps a terminal event small — the review is not repeated", async () => {
    await insertPluginAudit(db, { operationId: OP, event: "succeeded", actorId: null, reviewHash: HASH, targetKey: "plug" });
    const { rows } = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE id = $1`, [applyEventId(OP, "succeeded")]);
    expect(rows[0].detail).toEqual({ operationId: OP, reviewHash: HASH, outcome: "succeeded" });
  });

  it("is idempotent: two reconcilers writing the SAME event produce one row", async () => {
    const write = () => insertPluginAudit(db, { operationId: OP, event: "failed", actorId: null, reviewHash: HASH, targetKey: "plug" });
    await Promise.all([write(), write()]);
    await write();
    expect(await countOf("failed")).toBe(1);
  });

  it("THROWS when the same id would carry a different outcome", async () => {
    // Two writers disagreeing about what happened is a bug, not a race to be smoothed
    // over. DO NOTHING alone would keep whichever arrived first with no signal at all.
    await insertPluginAudit(db, { operationId: OP, event: "succeeded", actorId: null, reviewHash: HASH, targetKey: "plug" });
    await pool.query(
      `UPDATE audit_log SET detail = jsonb_set(detail, '{outcome}', '"something-else"'::jsonb) WHERE id = $1`,
      [applyEventId(OP, "succeeded")]);
    await expect(insertPluginAudit(db, { operationId: OP, event: "succeeded", actorId: null, reviewHash: HASH, targetKey: "plug" }))
      .rejects.toThrow(AuditInvariantViolation);
  });

  it("THROWS when the stored event belongs to a different review", async () => {
    await insertPluginAudit(db, { operationId: OP, event: "succeeded", actorId: null, reviewHash: HASH, targetKey: "plug" });
    await expect(insertPluginAudit(db, { operationId: OP, event: "succeeded", actorId: null, reviewHash: "a-different-hash", targetKey: "plug" }))
      .rejects.toThrow(AuditInvariantViolation);
  });

  it("rolls back the state transition it records when it throws", async () => {
    // This is why it throws rather than logs: the journal entry and the transition it
    // describes are one transaction, so either both land or neither does. A swallowed
    // failure would let the transition commit while the journal says otherwise.
    await insertPluginAudit(db, { operationId: OP, event: "succeeded", actorId: null, reviewHash: HASH, targetKey: "plug" });
    await pool.query(`INSERT INTO settings (key, value) VALUES ('audtest-marker', 'before') ON CONFLICT (key) DO UPDATE SET value = 'before'`);
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE settings SET value = 'after' WHERE key = 'audtest-marker'`);
      await insertPluginAudit(tx, { operationId: OP, event: "succeeded", actorId: null, reviewHash: "other", targetKey: "plug" });
    })).rejects.toThrow(AuditInvariantViolation);
    const { rows } = await pool.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'audtest-marker'`);
    expect(rows[0].value).toBe("before");
    await pool.query(`DELETE FROM settings WHERE key = 'audtest-marker'`);
  });

  it("distinguishes the five outcomes as separate rows", async () => {
    for (const event of ["accepted", "succeeded", "stale", "blocked", "failed"] as const) {
      await insertPluginAudit(db, { operationId: OP, event, actorId: null, reviewHash: HASH, targetKey: "plug" });
    }
    const { rows } = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE id LIKE $1 ORDER BY action`, [`plugin-apply:${OP}%`]);
    expect(rows.map((r) => r.action)).toEqual([
      "plugin.apply_accepted", "plugin.apply_blocked", "plugin.apply_failed",
      "plugin.apply_stale", "plugin.apply_succeeded",
    ]);
  });
});
