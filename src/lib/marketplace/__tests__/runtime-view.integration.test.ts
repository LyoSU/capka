import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "@/lib/db";
import { listEnabledServerConfigs, listServers } from "@/lib/mcp/service";
import { getSkillForRun, listAvailableSkills, listManagedSkills } from "@/lib/skills/service";
import { keepManageable, ownerStates } from "../runtime-view";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run runtime-view.integration
 *
 * What the agent is allowed to see while an apply is in flight
 * (docs/plugin-install-review-spec.md §8). The subject is the interaction between three
 * modules' queries and a jsonb predicate, so a mocked db would only re-assert the
 * fixture.
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const MK = "rvtest-mk";
const INSTALL = "rvtest-install";
const USER = "rvtest-user";
const CONNECTOR = "rvtest-conn";
const SKILL = "rvtest-skill";
const TAG = `catalog:${INSTALL}`;

const setApplyState = (state: Record<string, unknown> | null) => pool.query(
  state
    ? `UPDATE plugin_installs SET manifest = jsonb_set(manifest, '{applyState}', $2::jsonb) WHERE id = $1`
    : `UPDATE plugin_installs SET manifest = manifest - 'applyState' WHERE id = $1`,
  state ? [INSTALL, JSON.stringify(state)] : [INSTALL],
);

const applying = { operationId: "op", targetSha: "e".repeat(40), status: "applying", kind: "upgrade", startedAt: "2026-08-14T00:00:00.000Z", leaseExpiresAt: "2099-01-01T00:00:00.000Z" };

run("runtime sees only a committed view", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'rv test', 'rv@test.local', true, now(), now()) ON CONFLICT (id) DO NOTHING`, [USER]);
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/rv/test', 'rv')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [CONNECTOR]);
    await pool.query(`DELETE FROM skills WHERE id = $1`, [SKILL]);
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [USER]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [CONNECTOR]);
    await pool.query(`DELETE FROM skills WHERE id = $1`, [SKILL]);
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'rv-plugin', 'system', '{"schemaVersion":2,"committedRevision":1}'::jsonb)`, [INSTALL, MK]);
    await pool.query(
      `INSERT INTO mcp_servers (id, scope, name, transport, url, enabled, source)
       VALUES ($1, 'system', 'rvconn', 'http', 'https://rv.example/mcp', true, $2)`, [CONNECTOR, TAG]);
    await pool.query(
      `INSERT INTO skills (id, scope, name, body, enabled, source)
       VALUES ($1, 'system', 'rvskill', 'body', true, $2)`, [SKILL, TAG]);
  });

  const visible = async () => ({
    connector: (await listEnabledServerConfigs(USER)).some((c) => c.id === CONNECTOR),
    skill: (await listAvailableSkills(USER)).some((s) => s.id === SKILL),
    forRun: (await getSkillForRun(USER, null, "rvskill")) != null,
  });

  it("shows a ready install's resources", async () => {
    expect(await visible()).toEqual({ connector: true, skill: true, forRun: true });
  });

  it("hides everything an install is mid-apply on", async () => {
    await setApplyState(applying);
    expect(await visible()).toEqual({ connector: false, skill: false, forRun: false });
  });

  it("hides a failed install's resources", async () => {
    await setApplyState({ ...applying, status: "failed" });
    expect(await visible()).toEqual({ connector: false, skill: false, forRun: false });
  });

  it("hides an orphan — fail-closed when the owning install is gone", async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE id = $1`, [INSTALL]);
    expect(await visible()).toEqual({ connector: false, skill: false, forRun: false });
  });

  it("never touches anyone's `enabled` choice", async () => {
    // The whole reason this is a filter and not a column: hiding a plugin mid-apply must
    // not silently turn its connector off, or finishing the apply would leave the user's
    // own choice reversed.
    await setApplyState(applying);
    await listEnabledServerConfigs(USER);
    const { rows } = await pool.query<{ enabled: boolean }>(`SELECT enabled FROM mcp_servers WHERE id = $1`, [CONNECTOR]);
    expect(rows[0].enabled).toBe(true);
    await setApplyState(null);
    expect((await visible()).connector).toBe(true);
  });

  it("leaves hand-added resources alone", async () => {
    await pool.query(`UPDATE mcp_servers SET source = 'manual' WHERE id = $1`, [CONNECTOR]);
    await setApplyState(applying);
    expect((await visible()).connector).toBe(true);
  });

  it("surfaces an orphan in Connections, where it can be removed by hand", async () => {
    // An orphan has no Extensions entry to be managed from, so if the Connectors list
    // hid it too the row would be unreachable from every screen: unusable by the agent
    // and impossible to delete.
    await pool.query(`DELETE FROM plugin_installs WHERE id = $1`, [INSTALL]);
    const listed = (await listServers(USER)).find((s) => s.id === CONNECTOR);
    expect(listed).toBeDefined();
    // And says so. Reachable but rendered like a working connector is barely better than
    // hidden: the user sees a row that looks fine, and no run will ever use it.
    expect(listed?.orphaned).toBe(true);
  });

  it("keeps a ready plugin's connector OUT of Connections, since Extensions manages it", async () => {
    expect((await listServers(USER)).some((s) => s.id === CONNECTOR)).toBe(false);
  });

  it("does the SAME for skills, which is the half that was missing", async () => {
    // The Library filtered every `catalog:` row with no orphan exception, so a skill whose
    // install vanished was hidden here, hidden from every run, and had no Extensions row left
    // — the one state where a row cannot be reached from any screen at all.
    const library = async () => keepManageable(await listManagedSkills(USER, true));
    expect((await library()).some((s) => s.id === SKILL)).toBe(false); // ready → Extensions owns it
    await pool.query(`DELETE FROM plugin_installs WHERE id = $1`, [INSTALL]);
    const orphan = (await library()).find((s) => s.id === SKILL);
    expect(orphan?.orphaned).toBe(true);
  });

  it("marks a hand-added row not-orphaned rather than dropping the flag", async () => {
    // `orphaned: false` on every row it keeps, so a consumer reads one field instead of
    // inferring absence — the inference is what the connector list used to do inline.
    await pool.query(`UPDATE mcp_servers SET source = 'manual' WHERE id = $1`, [CONNECTOR]);
    expect((await listServers(USER)).find((s) => s.id === CONNECTOR)?.orphaned).toBe(false);
  });
});

run("ownerStates", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/rv/test', 'rv')
         ON CONFLICT (id) DO NOTHING`, [MK]);
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'rv-plugin', 'system', '{"schemaVersion":2,"committedRevision":1}'::jsonb)`, [INSTALL, MK]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });

  it("reports the four states per resource, not per install", async () => {
    // The management API needs this granularity: without it the UI cannot tell
    // "temporarily unavailable" from "gone", which §9 calls the worst state this feature
    // can produce.
    expect(await ownerStates([TAG])).toEqual(new Map([[TAG, "ready"]]));
    await setApplyState(applying);
    expect((await ownerStates([TAG])).get(TAG)).toBe("applying");
    await setApplyState({ ...applying, status: "failed" });
    expect((await ownerStates([TAG])).get(TAG)).toBe("failed");
    expect((await ownerStates(["catalog:no-such-install"])).get("catalog:no-such-install")).toBe("orphaned");
  });

  it("says nothing about a source that is not plugin-owned", async () => {
    // Absent from the map means "has no owner", which callers read as always visible.
    expect(await ownerStates(["manual", null, undefined])).toEqual(new Map());
  });
});
