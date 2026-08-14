import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run barrier.integration
 *
 * The apply barrier (§7). Only the GitHub fetch is stubbed — the claim, both hash checks,
 * the journal and the phase-dependent catch all run against real Postgres, because every
 * one of them is a compare-and-set and a mock would just replay the fixture.
 */
const h = vi.hoisted(() => ({
  tree: [] as { path: string; type: "blob" | "tree"; sha: string }[],
  files: {} as Record<string, string>,
  writes: 0,
  failWrites: false,
  preflight: vi.fn(async () => "allowed" as string),
}));

vi.mock("../fetch", () => ({
  ghFetch: async () => (() => { throw new Error("no network"); }) as unknown as typeof fetch,
  resolveCommit: async () => ({ sha: "b".repeat(40), date: null, message: null }),
  ghTree: async () => h.tree,
  ghRaw: async (_o: string, _r: string, _s: string, path: string) => h.files[path] ?? null,
  diffTrees: vi.fn(),
}));
vi.mock("@/lib/mcp/oauth/detect", () => ({ detectAuthKind: async () => "token" }));
vi.mock("@/lib/net/ssrf", () => ({ preflightUrl: h.preflight, assertSafeUrl: async () => {} }));

import { pool } from "@/lib/db";
import { applyPluginReviewed, previewPluginApply } from "../barrier";
import { readApplyState } from "../operation";
import { readStoredManifest } from "../manifest-store";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const MK = "brtest-mk";
const ACTOR = "brtest-actor";
const SHA = "b".repeat(40);
const GH = { owner: "acme", repo: "plug", ref: SHA, subdir: "" };

const FIXTURE = { ".mcp.json": JSON.stringify({ mcpServers: { api: { url: "https://api.example.com/mcp" } } }) };

const load = (files: Record<string, string>) => {
  h.files = files;
  h.tree = Object.keys(files).map((path) => ({ path, type: "blob" as const, sha: "s" }));
};

const cleanup = async () => {
  await pool.query(`DELETE FROM audit_log WHERE id LIKE 'plugin-apply:%' AND target_key = 'plug'`);
  await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
};

/** The writer the barrier drives. Counts calls so "did any resource change?" is observable,
 *  and can be made to fail to exercise the `mutating` phase. */
const performWrites = async () => {
  h.writes += 1;
  if (h.failWrites) throw new Error("write blew up");
  return { schemaVersion: 2, inventory: { skills: [], connectors: ["api"], ignored: [], notes: [] }, installSurface: null, committedRevision: 1 } as Record<string, unknown>;
};

/** Reviews here are read as an admin; who may delete which policy rule is asserted in
 *  policy-disposition.integration. */
const ADMIN_ACTOR = { userId: "barrier-admin", isAdmin: true };

const preview = (installId: string | null) => previewPluginApply({
  gh: GH, marketplaceId: MK, pluginName: "plug", scope: "system", ownerId: null,
  installId, targetSha: SHA, storedManifestRaw: undefined, actor: ADMIN_ACTOR,
});

const apply = (installId: string | null, reviewHash: string) => applyPluginReviewed({
  gh: GH, marketplaceId: MK, pluginName: "plug", scope: "system", ownerId: null,
  installId, targetSha: SHA, actorId: ACTOR, reviewHash, dispositions: {}, performWrites,
  actor: { userId: ACTOR, isAdmin: true },
});

const eventCount = async (event: string) => {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target_key = 'plug'`, [event]);
  return Number(rows[0].n);
};

run("apply barrier", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'br test', 'br@test.local', true, now(), now()) ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/acme/plug', 'br')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ACTOR]);
  });

  beforeEach(async () => {
    await cleanup();
    h.writes = 0;
    h.failWrites = false;
    load(FIXTURE);
  });

  it("refuses a malformed hash SYNTACTICALLY, with no database access and nothing audited", async () => {
    // Resolving who may do this needs the DB, so it comes second on purpose: a garbage
    // request must not cost a query, and it must not leave a journal entry either, because
    // nothing was attempted.
    for (const bad of ["", "nope", "A".repeat(64), "0".repeat(63)]) {
      expect(await apply(null, bad)).toEqual({ outcome: "rejected", reason: "malformed_hash" });
    }
    expect(await eventCount("plugin.apply_stale")).toBe(0);
    expect(h.writes).toBe(0);
  });

  it("applies a first install and publishes the committed view", async () => {
    const { review } = await preview(null);
    // A first install is all `expansion` — the baseline is empty, which is a KNOWN fact.
    expect(review.gate).toBe("requires_consent");
    expect(await apply(null, review.reviewHash)).toEqual({ outcome: "succeeded" });
    expect(h.writes).toBe(1);

    const { rows } = await pool.query<{ id: string; manifest: unknown }>(
      `SELECT id, manifest FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    expect(rows).toHaveLength(1);
    // Finalize IS the publication moment: the claim is gone and the view is committed.
    expect(await readApplyState(rows[0].id)).toBeNull();
    expect(readStoredManifest(rows[0].manifest).inventory.connectors).toEqual(["api"]);
    expect(await eventCount("plugin.apply_accepted")).toBe(1);
    expect(await eventCount("plugin.apply_succeeded")).toBe(1);
  });

  it("refuses a hash that no longer describes reality, without touching anything", async () => {
    const { review } = await preview(null);
    // Upstream shipped a second connector between review and apply.
    load({ ".mcp.json": JSON.stringify({ mcpServers: {
      api: { url: "https://api.example.com/mcp" }, extra: { url: "https://extra.example.com/mcp" },
    } }) });
    const out = await apply(null, review.reviewHash);
    expect(out.outcome).toBe("stale");
    expect(h.writes).toBe(0);
    // A refusal IS audited before any claim — the one thing invariant 3 permits unclaimed,
    // because a refusal that left no trace would hide the attempts worth seeing.
    expect(await eventCount("plugin.apply_stale")).toBe(1);
    // And no staging row is stranded.
    const { rows } = await pool.query(`SELECT id FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    expect(rows).toHaveLength(0);
  });

  it("carries the FRESH review in a stale refusal, so the screen can re-present it", async () => {
    const { review } = await preview(null);
    load({ ".mcp.json": JSON.stringify({ mcpServers: { renamed: { url: "https://api.example.com/mcp" } } }) });
    const out = await apply(null, review.reviewHash);
    if (out.outcome !== "stale") throw new Error("expected stale");
    expect(out.review.reviewHash).not.toBe(review.reviewHash);
    expect(out.review.surface.connectors.map((c) => c.name)).toEqual(["renamed"]);
  });

  it("does not let a valid hash override cannot_apply", async () => {
    // The consent may be perfectly valid; DNS turning unsafe is not a different decision to
    // make but a reason there is nothing safe to apply.
    h.preflight.mockResolvedValue("blocked");
    try {
      const { review } = await preview(null);
      expect(review.gate).toBe("cannot_apply");
      const out = await apply(null, review.reviewHash);
      expect(out.outcome).toBe("blocked");
      expect(h.writes).toBe(0);
      expect(await eventCount("plugin.apply_blocked")).toBe(1);
    } finally {
      h.preflight.mockResolvedValue("allowed");
    }
  });

  it("marks the operation FAILED when a resource write blows up, and does not release it", async () => {
    // Resources were already being changed, so releasing the claim would assert that
    // nothing happened. `failed` is what makes the half-applied state visible.
    const { review } = await preview(null);
    h.failWrites = true;
    const out = await apply(null, review.reviewHash);
    expect(out).toEqual({ outcome: "failed", errorCode: "write_failed" });

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    expect(rows).toHaveLength(1);
    expect((await readApplyState(rows[0].id))!.status).toBe("failed");
    expect(await eventCount("plugin.apply_failed")).toBe(1);
    expect(await eventCount("plugin.apply_succeeded")).toBe(0);
  });

  it("is claimable again after a failure, and the retry succeeds", async () => {
    const { review } = await preview(null);
    h.failWrites = true;
    await apply(null, review.reviewHash);
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    h.failWrites = false;

    // The retry is an upgrade of the existing (failed) row, reviewed afresh.
    const second = await previewPluginApply({
      gh: GH, marketplaceId: MK, pluginName: "plug", scope: "system", ownerId: null,
      installId: rows[0].id, targetSha: SHA, storedManifestRaw: undefined, actor: ADMIN_ACTOR,
    });
    expect(await apply(rows[0].id, second.review.reviewHash)).toEqual({ outcome: "succeeded" });
    expect(await readApplyState(rows[0].id)).toBeNull();
  });

  it("lets only one of two parallel applies of the same review win", async () => {
    const { review } = await preview(null);
    const [a, b] = await Promise.all([apply(null, review.reviewHash), apply(null, review.reviewHash)]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["stale", "succeeded"]);
    expect(h.writes).toBe(1);
    const { rows } = await pool.query(`SELECT id FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    expect(rows).toHaveLength(1);
  });

  it("records `accepted` and the claim atomically", async () => {
    // The journal entry and the claim are one transaction, so there is no state where an
    // install is claimed with no record of who claimed it.
    const { review } = await preview(null);
    await apply(null, review.reviewHash);
    const { rows } = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE action = 'plugin.apply_accepted' AND target_key = 'plug'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail.reviewHash).toBe(review.reviewHash);
    // The full review is stored once, here, and the terminal event stays small.
    expect(rows[0].detail.review).toBeTruthy();
  });

  it("never lets a literal command line into the journal", async () => {
    load({ ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["--token", "t0psecret"] } } }) });
    const { review } = await preview(null);
    expect(review.execution).toEqual([{ connectorName: "gh", command: "npx", args: ["--token", "t0psecret"] }]);
    await apply(null, review.reviewHash);
    const { rows } = await pool.query<{ detail: unknown }>(
      `SELECT detail FROM audit_log WHERE target_key = 'plug'`);
    for (const r of rows) expect(JSON.stringify(r.detail)).not.toContain("t0psecret");
  });
});

run("preview", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/acme/plug', 'br')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });
  afterAll(async () => {
    await cleanup();
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });
  beforeEach(() => { load(FIXTURE); });

  it("touches nothing and is not audited", async () => {
    // Opening or dismissing a preview is not a decision, and a record per preview would
    // make the trail unreadable exactly where it has to be legible.
    const before = await pool.query(`SELECT count(*) FROM audit_log`);
    await preview(null);
    await preview(null);
    const after = await pool.query(`SELECT count(*) FROM audit_log`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const { rows } = await pool.query(`SELECT id FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    expect(rows).toHaveLength(0);
  });

  it("is reproducible for one commit", async () => {
    const a = await preview(null);
    const b = await preview(null);
    expect(a.review.reviewHash).toBe(b.review.reviewHash);
  });
});
