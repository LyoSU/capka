import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "@/lib/db";
import { normalizeEndpoint } from "../canonical";
import { readRuntimeSurface } from "../runtime-surface";
import { SURFACE_SCHEMA_VERSION, type StoredInstallSurface } from "../surface";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run runtime-credential.integration
 *
 * The credential axis of `runtimeBefore` for a PLACEHOLDER connector — one installed with a
 * `${...}` header, whose secrets `applyPlanResources` deliberately never persists.
 *
 * This exists because the branch under test was UNREACHABLE and nothing noticed. The fallback
 * to the artifact's digest was guarded by `normalizeEndpoint(url) === prior.endpoint`, and
 * `normalizeEndpoint` returns a fresh object every call, so `===` was always false. Every
 * placeholder connector therefore reported a credential change on every single upgrade — the
 * permanent false positive `runtime-surface.ts`'s own header argues against, introduced while
 * fixing the opposite defect (a changed URL reading as `unchanged`).
 *
 * So both directions are asserted, and the first one is the one that regresses silently: a
 * test that only proved "a changed URL is detected" passes just as happily when the answer is
 * "everything is always changed".
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const INSTALL = "rctest-install";
const MK = "rctest-mk";
const NAME = "rctest-conn";
const TAG = `catalog:${INSTALL}`;
const KEY = "a".repeat(64);
const URL_ = "https://api.example.com/mcp";

/** The committed artifact: a placeholder connector, so it carries a `credentialFingerprint`
 *  the row cannot reproduce and an endpoint to compare against. */
const artifact = (url: string): StoredInstallSurface => ({
  schemaVersion: SURFACE_SCHEMA_VERSION,
  completeness: "derived",
  connectors: [{
    projection: "stored", name: NAME, originKey: ".mcp.json#conn", transport: "http",
    endpoint: normalizeEndpoint(url) ?? undefined,
    authKind: "token",
    credentialFingerprint: "artifact-digest",
    secretKeys: ["authorization"], needsSecret: true,
    runsThirdPartyCode: false, bundled: false, activation: "enabled",
  }],
  skills: [],
  files: { projection: "stored", count: 0, bytes: 0, rootHash: "r", entrypoints: [], files: [] },
});

/** A row with NO secrets — exactly what a placeholder connector persists. */
const addRow = (url: string) => pool.query(
  `INSERT INTO mcp_servers (id, scope, user_id, project_id, name, transport, url, enabled, auth_kind, source, created_at, updated_at)
   VALUES ($1, 'system', NULL, NULL, $2, 'http', $3, true, 'token', $4, now(), now())`,
  [INSTALL, NAME, url, TAG]);

const readCredential = async (committed: StoredInstallSurface) =>
  (await readRuntimeSurface(INSTALL, committed, KEY)).connectors[0]?.credentialFingerprint;

run("placeholder connector credentials", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/rc/test', 'rc')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });

  beforeEach(() => pool.query(`DELETE FROM mcp_servers WHERE source = $1`, [TAG]));

  afterAll(async () => {
    await pool.query(`DELETE FROM mcp_servers WHERE source = $1`, [TAG]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });

  it("reports NO change while the row still points at the same place", async () => {
    // The regression this catches. Reference equality made this branch dead, so the answer was
    // a fresh digest — never equal to the artifact's — on every upgrade forever.
    await addRow(URL_);
    expect(await readCredential(artifact(URL_))).toBe("artifact-digest");
  });

  it("compares by VALUE, not by identity, across equivalent spellings of one URL", async () => {
    // `normalizeEndpoint` already folds these together; the point is that the comparison uses
    // its output as a value. An uppercase host, a default port and a trailing slash are the
    // same endpoint, and none of them should read as a credential change.
    await addRow("https://API.Example.com:443/mcp/");
    expect(await readCredential(artifact(URL_))).toBe("artifact-digest");
  });

  it("reports a change when the row points somewhere else", async () => {
    // The defect that motivated the fallback guard in the first place: the digest covers the
    // url AND the headers together, so copying it across a changed url said `unchanged` about a
    // connector now talking to another host.
    await addRow("https://evil.example.com/mcp");
    expect(await readCredential(artifact(URL_))).not.toBe("artifact-digest");
  });

  it("reports a change when only the query keys differ", async () => {
    await addRow(`${URL_}?tenant=other`);
    expect(await readCredential(artifact(URL_))).not.toBe("artifact-digest");
  });

  it("reports a change when the artifact recorded no endpoint at all", async () => {
    // Nothing to compare against is not a match. Conservative on purpose — but bounded to the
    // case where the artifact itself could not parse its own URL.
    await addRow(URL_);
    const noEndpoint = artifact(URL_);
    delete noEndpoint.connectors[0].endpoint;
    expect(await readCredential(noEndpoint)).not.toBe("artifact-digest");
  });
});
