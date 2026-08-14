import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "@/lib/db";
import { deleteServer, setEnabled, upsertStdioServer } from "@/lib/mcp/service";
import { writeReviewedPlan } from "../install";
import { deleteSkill, ingestSkill, setSkillEnabled } from "@/lib/skills/service";
import { FencedWriteError, MANUAL } from "../fence";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run fence.integration
 *
 * The mutation fence (docs/plugin-install-review-spec.md §7). Every assertion here is
 * about an SQL predicate, and the specific bug being guarded — that a SINGLE
 * "is anyone applying?" test has an inverted hole once the reconciler sets `failed` —
 * is invisible to any test that stubs the query.
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const MK = "fntest-mk";
const INSTALL = "fntest-install";
const TAG = `catalog:${INSTALL}`;
const OURS = { kind: "plugin-apply" as const, operationId: "op-ours" };
const THEIRS = { kind: "plugin-apply" as const, operationId: "op-theirs" };

const state = (over: Record<string, unknown> = {}) => ({
  operationId: "op-ours", targetSha: "f".repeat(40), status: "applying",
  kind: "upgrade", startedAt: "2026-08-14T00:00:00.000Z",
  leaseExpiresAt: "2099-01-01T00:00:00.000Z", ...over,
});

const setApplyState = (s: Record<string, unknown> | null) => pool.query(
  s ? `UPDATE plugin_installs SET manifest = jsonb_set(manifest, '{applyState}', $2::jsonb) WHERE id = $1`
    : `UPDATE plugin_installs SET manifest = manifest - 'applyState' WHERE id = $1`,
  s ? [INSTALL, JSON.stringify(s)] : [INSTALL],
);

const target = { scope: "system" as const, userId: null, projectId: null };
const parsed = (name: string) => ({ name, description: undefined, body: "body", frontmatter: {} });

run("mutation fence", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/fn/test', 'fn')
         ON CONFLICT (id) DO NOTHING`, [MK]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM mcp_servers WHERE source = $1`, [TAG]);
    await pool.query(`DELETE FROM skills WHERE source = $1`, [TAG]);
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(`DELETE FROM plugin_marketplaces WHERE id = $1`, [MK]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM mcp_servers WHERE source = $1`, [TAG]);
    await pool.query(`DELETE FROM skills WHERE source = $1`, [TAG]);
    await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id = $1`, [MK]);
    await pool.query(
      `INSERT INTO plugin_installs (id, marketplace_id, plugin_name, scope, manifest)
       VALUES ($1, $2, 'fn-plugin', 'system', '{"schemaVersion":2,"committedRevision":1}'::jsonb)`, [INSTALL, MK]);
  });

  /** A plugin-owned connector row, created while the install is applying under `OURS`. */
  const seedConnector = async () => {
    await setApplyState(state());
    const id = await upsertStdioServer({ ...target, name: "fnconn", command: "npx", source: TAG, authority: OURS });
    return id;
  };

  it("lets our own operation write, and refuses a foreign one", async () => {
    const id = await seedConnector();
    expect(await setEnabled(id, true, OURS)).toBe("updated");
    expect(await setEnabled(id, true, THEIRS)).toBe("fenced");
  });

  it("refuses an apply-path write after the operation was marked failed", async () => {
    // THE hole this file exists for. A single "is anyone applying?" predicate is INVERTED
    // here: once the reconciler sets `failed`, no applying row exists at all, so a
    // dispossessed worker would find nothing in its way and carry on writing.
    const id = await seedConnector();
    await setApplyState(state({ status: "failed" }));
    expect(await setEnabled(id, true, OURS)).toBe("fenced");
  });

  it("refuses an apply-path write after finalize cleared the claim", async () => {
    const id = await seedConnector();
    await setApplyState(null);
    expect(await setEnabled(id, true, OURS)).toBe("fenced");
  });

  it("refuses an apply-path write once the lease has lapsed", async () => {
    const id = await seedConnector();
    await setApplyState(state({ leaseExpiresAt: "2020-01-01T00:00:00.000Z" }));
    expect(await setEnabled(id, true, OURS)).toBe("fenced");
  });

  it("refuses a MANUAL write while an apply is in flight", async () => {
    const id = await seedConnector();
    expect(await setEnabled(id, true, MANUAL)).toBe("fenced");
    await setApplyState(null);
    expect(await setEnabled(id, true, MANUAL)).toBe("updated");
  });

  it("tells `missing` apart from `fenced`", async () => {
    // A prune runs the delete for every row it does not keep, so `missing` is a success
    // there while `fenced` is always a conflict. A boolean could not say which happened.
    expect(await setEnabled("no-such-connector", true, MANUAL)).toBe("missing");
    expect(await deleteSkill("no-such-skill", MANUAL)).toBe("missing");
    const id = await seedConnector();
    expect(await deleteServer(id, THEIRS)).toBe("fenced");
  });

  it("leaves hand-added rows alone, whatever any plugin is doing", async () => {
    await setApplyState(state());
    const id = await upsertStdioServer({ ...target, name: "fnmanual", command: "npx", authority: MANUAL });
    try {
      expect(await setEnabled(id, false, MANUAL)).toBe("updated");
    } finally {
      await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [id]);
    }
  });

  it("refuses a plugin-owned INSERT that no live operation of ours owns", async () => {
    // Stricter than an update, and what makes a NEW orphan impossible: an insert tagged
    // for an install that is not applying under our operation simply does not happen.
    await setApplyState(null);
    await expect(upsertStdioServer({ ...target, name: "fnorphan", command: "npx", source: TAG, authority: OURS }))
      .rejects.toThrow(FencedWriteError);
    await setApplyState(state({ status: "failed" }));
    await expect(upsertStdioServer({ ...target, name: "fnorphan", command: "npx", source: TAG, authority: OURS }))
      .rejects.toThrow(FencedWriteError);
    const { rows } = await pool.query(`SELECT id FROM mcp_servers WHERE source = $1`, [TAG]);
    expect(rows).toHaveLength(0);
  });

  it("applies the same rules to skills", async () => {
    await setApplyState(state());
    const id = await ingestSkill(parsed("fnskill"), [], { ...target, source: TAG, authority: OURS });
    expect(await setSkillEnabled(id, true, OURS)).toBe("updated");
    expect(await setSkillEnabled(id, true, THEIRS)).toBe("fenced");
    await setApplyState(state({ status: "failed" }));
    expect(await setSkillEnabled(id, true, OURS)).toBe("fenced");
    expect(await deleteSkill(id, OURS)).toBe("fenced");
  });

  it("refuses an UPDATE through the upsert path too, not just enable/delete", async () => {
    // ingestSkill's update branch has no id to return when refused, so it throws — the
    // caller asked for the id of a row it was not allowed to write.
    await setApplyState(state());
    await ingestSkill(parsed("fnskill2"), [], { ...target, source: TAG, authority: OURS });
    await setApplyState(state({ operationId: "op-someone-else" }));
    await expect(ingestSkill(parsed("fnskill2"), [], { ...target, source: TAG, authority: OURS }))
      .rejects.toThrow(FencedWriteError);
  });
});

run("the fence covers the bytes that actually run", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ($1, 'https://github.com/fn/test', 'fn')
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
       VALUES ($1, $2, 'fn-plugin', 'system', '{"schemaVersion":2,"committedRevision":1}'::jsonb)`, [INSTALL, MK]);
  });

  const plan = (content: string) => ({
    commit: { sha: "f".repeat(40), date: null, message: null },
    connectors: [], skills: [], ignored: [], notes: [], needsFiles: true,
    files: [{ path: "bin/run.sh", content: Buffer.from(content, "utf8").toString("base64") }],
  });
  const obs = { urls: {}, detectedAuth: {}, policy: { blockPrivate: false }, observedAt: "2026-08-14T00:00:00.000Z" };

  const write = (operationId: string, content: string) => writeReviewedPlan({
    operationId, installId: INSTALL, plan: plan(content) as never, observations: obs,
    target, priorManifest: undefined, fallbackVersion: "fffffff",
  });

  const bytes = async () => {
    const { rows } = await pool.query<{ content: string }>(
      `SELECT content FROM plugin_files WHERE install_id = $1`, [INSTALL]);
    return rows.map((r) => Buffer.from(r.content, "base64").toString("utf8"));
  };

  it("refuses a dispossessed worker's file write — the race that beat the old fence", async () => {
    // A holds the claim and writes. Its lease is then taken (the reaper's transition), B
    // applies a safe version. A wakes up and tries again: the parent rows are fenced, but the
    // FILES used to be an unconditional delete+insert, so A would overwrite them while the
    // install already read `ready`. The row said B, the sandbox ran A.
    await setApplyState(state({ operationId: "op-A" }));
    await write("op-A", "#!/bin/sh\necho A\n");
    expect(await bytes()).toEqual(["#!/bin/sh\necho A\n"]);

    // The reaper takes it from A; B claims and writes.
    await setApplyState(state({ operationId: "op-B" }));
    await write("op-B", "#!/bin/sh\necho B\n");
    expect(await bytes()).toEqual(["#!/bin/sh\necho B\n"]);

    // A wakes up. It must write NOTHING.
    await expect(write("op-A", "#!/bin/sh\necho A-again\n")).rejects.toThrow(FencedWriteError);
    expect(await bytes()).toEqual(["#!/bin/sh\necho B\n"]);
  });

  it("refuses a file write once the operation has been marked failed", async () => {
    await setApplyState(state({ operationId: "op-A" }));
    await write("op-A", "one");
    await setApplyState(state({ operationId: "op-A", status: "failed" }));
    await expect(write("op-A", "two")).rejects.toThrow(FencedWriteError);
    expect(await bytes()).toEqual(["one"]);
  });

  it("refuses a file write after finalize cleared the claim", async () => {
    await setApplyState(state({ operationId: "op-A" }));
    await write("op-A", "one");
    await setApplyState(null);
    await expect(write("op-A", "two")).rejects.toThrow(FencedWriteError);
    expect(await bytes()).toEqual(["one"]);
  });

  it("leaves version and commitSha untouched when the file write is refused", async () => {
    // The metadata update rides in the same transaction, so a refused apply cannot leave the
    // row claiming a version whose bytes were never written.
    await setApplyState(state({ operationId: "op-A" }));
    await write("op-A", "one");
    const before = await pool.query<{ commit_sha: string }>(
      `SELECT commit_sha FROM plugin_installs WHERE id = $1`, [INSTALL]);
    await setApplyState(null);
    await expect(write("op-A", "two")).rejects.toThrow(FencedWriteError);
    const after = await pool.query<{ commit_sha: string }>(
      `SELECT commit_sha FROM plugin_installs WHERE id = $1`, [INSTALL]);
    expect(after.rows[0].commit_sha).toBe(before.rows[0].commit_sha);
  });
});
