import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "@/lib/db";
import {
  claimApply, finalizeApply, markApplyFailed, readApplyState,
  reconcileStaleApplies, releaseApplyClaim, renewApplyLease,
} from "../operation";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run operation.integration
 *
 * The subject of every assertion here is an SQL predicate, which a mock cannot prove:
 * a stubbed `pool.query` would happily report whatever the test wanted. That is why
 * docs/plugin-install-review-spec.md §12 records Postgres for these groups as an
 * acceptance condition rather than a preference.
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const MK = "optest-mk";
const INSTALL = "optest-install";
const SHA = "d".repeat(40);

const manifest = (over: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 2,
  inventory: { skills: [], connectors: [], ignored: [], notes: [] },
  installSurface: null,
  committedRevision: 3,
  ...over,
});

run("plugin apply claim / lease / release", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/optest/repo', 'optest')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'optest-plugin', 'system', $3::jsonb)`, [INSTALL, MK, manifest()]);
  });

  const claim = (operationId: string, expectedRevision = 3, kind: "install" | "upgrade" | "retry" = "upgrade") =>
    claimApply({ installId: INSTALL, operationId, expectedRevision, targetSha: SHA, kind });

  it("claims a ready install and records the operation", async () => {
    expect(await claim("op-1")).toEqual({ ok: true, operationId: "op-1" });
    const state = await readApplyState(INSTALL);
    expect(state).toMatchObject({ operationId: "op-1", status: "applying", kind: "upgrade", targetSha: SHA });
    expect(Date.parse(state!.leaseExpiresAt)).toBeGreaterThan(Date.now());
  });

  it("refuses a second claim while one is in flight — only one of two parallel claims wins", async () => {
    const [a, b] = await Promise.all([claim("op-a"), claim("op-b")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("refuses a claim planned against an older committed state", async () => {
    // The whole point of the revision: a review computed before someone else's upgrade
    // landed must not apply on top of it.
    expect(await claim("op-stale", 2)).toEqual({ ok: false, reason: "conflict" });
    expect(await readApplyState(INSTALL)).toBeNull();
  });

  it("treats a legacy row's absent counter as 0, the value a first claim expects", async () => {
    await pool.query(`UPDATE plugin_installs SET manifest = '{"skills":[],"connectors":[]}'::jsonb WHERE id = $1`, [INSTALL]);
    expect(await claim("op-legacy", 0)).toMatchObject({ ok: true });
  });

  it("refuses before touching the database when the expected revision could not be read", async () => {
    // NaN reaches SQL as NULL, where `= NULL` is never true but the intent is invisible.
    // Refusing in TypeScript keeps the reason legible.
    expect(await claim("op-nan", Number.NaN)).toEqual({ ok: false, reason: "conflict" });
    expect(await readApplyState(INSTALL)).toBeNull();
  });

  it("is claimable again after a failure — that is the retry path", async () => {
    await claim("op-1");
    expect(await markApplyFailed(INSTALL, "op-1")).toBe(true);
    expect(await claim("op-2", 3, "retry")).toMatchObject({ ok: true });
  });

  it("renews only its own lease", async () => {
    await claim("op-1");
    const before = (await readApplyState(INSTALL))!.leaseExpiresAt;
    expect(await renewApplyLease(INSTALL, "op-other")).toBe(false);
    expect(await renewApplyLease(INSTALL, "op-1")).toBe(true);
    expect((await readApplyState(INSTALL))!.leaseExpiresAt).not.toBe(before);
  });
});

run("operation-owned transitions", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/optest/repo', 'optest')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'optest-plugin', 'system', $3::jsonb)`, [INSTALL, MK, manifest()]);
    await claimApply({ installId: INSTALL, operationId: "mine", expectedRevision: 3, targetSha: SHA, kind: "upgrade" });
  });

  const nextManifest = () => JSON.parse(manifest({ committedRevision: 4 })) as Record<string, unknown>;

  it("lets only the owning operation finalize", async () => {
    expect(await finalizeApply({ installId: INSTALL, operationId: "someone-else", manifest: nextManifest() })).toBe(false);
    expect(await finalizeApply({ installId: INSTALL, operationId: "mine", manifest: nextManifest() })).toBe(true);
  });

  it("clears the claim on finalize — finalize IS the publication moment", async () => {
    await finalizeApply({ installId: INSTALL, operationId: "mine", manifest: nextManifest() });
    expect(await readApplyState(INSTALL)).toBeNull();
    const { rows } = await pool.query<{ rev: string }>(
      `SELECT manifest #>> '{committedRevision}' AS rev FROM plugin_installs WHERE id = $1`, [INSTALL]);
    expect(rows[0].rev).toBe("4");
  });

  it("cannot finalize twice", async () => {
    expect(await finalizeApply({ installId: INSTALL, operationId: "mine", manifest: nextManifest() })).toBe(true);
    expect(await finalizeApply({ installId: INSTALL, operationId: "mine", manifest: nextManifest() })).toBe(false);
  });

  it("lets only the owning operation mark a failure", async () => {
    expect(await markApplyFailed(INSTALL, "someone-else")).toBe(false);
    expect(await markApplyFailed(INSTALL, "mine")).toBe(true);
    expect((await readApplyState(INSTALL))!.status).toBe("failed");
  });

  it("cannot finalize after the reaper won", async () => {
    // A dispossessed worker waking up must not publish a view nobody is waiting for.
    await pool.query(
      `UPDATE plugin_installs SET manifest = jsonb_set(manifest, '{applyState,leaseExpiresAt}',
         to_jsonb(to_char((now() - interval '5 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`,
      [INSTALL]);
    expect(await reconcileStaleApplies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ installId: INSTALL, operationId: "mine" }),
    ]));
    expect(await finalizeApply({ installId: INSTALL, operationId: "mine", manifest: nextManifest() })).toBe(false);
    expect(await renewApplyLease(INSTALL, "mine")).toBe(false);
  });

  it("is taken by exactly one of two reconcilers", async () => {
    await pool.query(
      `UPDATE plugin_installs SET manifest = jsonb_set(manifest, '{applyState,leaseExpiresAt}',
         to_jsonb(to_char((now() - interval '5 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`,
      [INSTALL]);
    const [a, b] = await Promise.all([reconcileStaleApplies(), reconcileStaleApplies()]);
    const mine = [...a, ...b].filter((r) => r.installId === INSTALL);
    expect(mine).toHaveLength(1);
  });

  it("leaves a healthy lease alone", async () => {
    expect((await reconcileStaleApplies()).some((r) => r.installId === INSTALL)).toBe(false);
    expect((await readApplyState(INSTALL))!.status).toBe("applying");
  });

  it("does not reap a lease that expired within the renewal margin", async () => {
    // A single missed renewal is a DB hiccup, not a dead worker.
    await pool.query(
      `UPDATE plugin_installs SET manifest = jsonb_set(manifest, '{applyState,leaseExpiresAt}',
         to_jsonb(to_char((now() - interval '2 seconds') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`,
      [INSTALL]);
    expect((await reconcileStaleApplies()).some((r) => r.installId === INSTALL)).toBe(false);
  });
});

run("releasing a claim is three different operations", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/optest/repo', 'optest')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });

  const seed = async (kind: "install" | "upgrade" | "retry") => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'optest-plugin', 'system', $3::jsonb)`, [INSTALL, MK, manifest()]);
    await claimApply({ installId: INSTALL, operationId: "mine", expectedRevision: 3, targetSha: SHA, kind });
  };

  it("install: deletes the staging row, because there is no committed state to return to", async () => {
    await seed("install");
    expect(await releaseApplyClaim(INSTALL, "mine", "install")).toBe(true);
    const { rows } = await pool.query(`SELECT id FROM plugin_installs WHERE id = $1`, [INSTALL]);
    expect(rows).toHaveLength(0);
  });

  it("upgrade: clears the claim and leaves the committed view untouched", async () => {
    await seed("upgrade");
    expect(await releaseApplyClaim(INSTALL, "mine", "upgrade")).toBe(true);
    expect(await readApplyState(INSTALL)).toBeNull();
    const { rows } = await pool.query<{ rev: string }>(
      `SELECT manifest #>> '{committedRevision}' AS rev FROM plugin_installs WHERE id = $1`, [INSTALL]);
    expect(rows[0].rev).toBe("3");
  });

  it("retry: restores `failed`, NOT null — the earlier failure is still true", async () => {
    // Clearing it would let a retry that itself went stale quietly erase the problem the
    // operator was trying to fix.
    await seed("retry");
    expect(await releaseApplyClaim(INSTALL, "mine", "retry")).toBe(true);
    expect((await readApplyState(INSTALL))!.status).toBe("failed");
  });

  it("refuses to release someone else's claim", async () => {
    await seed("upgrade");
    expect(await releaseApplyClaim(INSTALL, "not-mine", "upgrade")).toBe(false);
    expect((await readApplyState(INSTALL))!.operationId).toBe("mine");
  });
});

run("first-install claim is the staging insert", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });

  it("lets exactly one of two parallel first installs insert", async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/optest/repo', 'optest')
         ON CONFLICT (id) DO NOTHING`, [MK]);
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);

    const insert = (id: string) => pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'race-plugin', 'system', '{}'::jsonb)`, [id, MK]);
    const results = await Promise.allSettled([insert("race-a"), insert("race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("still allows one system and one personal install of the same plugin", async () => {
    // The two partial indexes exist precisely so a member's personal install is not
    // mistaken for a duplicate of the org-wide one.
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    const { rows: [u] } = await pool.query<{ id: string }>(`SELECT id FROM "user" LIMIT 1`);
    if (!u) return; // no users in this dev DB; the system-scope half is covered above
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, user_id, manifest)
       VALUES ('scope-sys', $1, 'scoped', 'system', NULL, '{}'::jsonb),
              ('scope-usr', $1, 'scoped', 'user', $2, '{}'::jsonb)`, [MK, u.id]);
    const { rows } = await pool.query(`SELECT id FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    expect(rows).toHaveLength(2);
  });
});
