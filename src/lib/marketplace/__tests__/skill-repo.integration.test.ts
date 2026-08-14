import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run skill-repo.integration
 *
 * `manage skill add {repo}` models a bare skills repo as a one-plugin marketplace, because
 * `plugin_installs` needs a parent row to point at. That row is an implementation detail of
 * one person's install — these tests are about it staying one, instead of turning a member's
 * personal install into an edit of what the whole organization sees in Browse.
 */
const h = vi.hoisted(() => ({
  tree: [] as { path: string; type: "blob" | "tree"; sha: string }[],
  files: {} as Record<string, string>,
}));

vi.mock("../fetch", () => ({
  ghFetch: async () => (() => { throw new Error("no network"); }) as unknown as typeof fetch,
  resolveCommit: async () => ({ sha: "c".repeat(40), date: null, message: null }),
  ghTree: async () => h.tree,
  ghRaw: async (_o: string, _r: string, _s: string, path: string) => h.files[path] ?? null,
  diffTrees: vi.fn(),
}));
vi.mock("@/lib/mcp/oauth/detect", () => ({ detectAuthKind: async () => "token" }));
vi.mock("@/lib/net/ssrf", () => ({ preflightUrl: async () => "allowed", assertSafeUrl: async () => {} }));

import { pool } from "@/lib/db";
import { applySkillRepoInstall, previewSkillRepoInstall } from "../skill-repo";
import { listMarketplaces, deleteMarketplace } from "../service";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const USER = "srtest-user";
const ACTOR = { userId: USER, isAdmin: false };
const URL_A = "https://github.com/acme/skills-a";
const URL_B = "https://github.com/acme/skills-b";

const load = (name: string) => {
  h.files = {
    [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: does ${name} things\n---\n\nDo the thing.\n`,
  };
  h.tree = Object.keys(h.files).map((path) => ({ path, type: "blob" as const, sha: "s" }));
};

/** Everything these tests write, by the prefixes they write it under. */
const cleanup = async () => {
  await pool.query(`DELETE FROM plugin_installs WHERE marketplace_id IN (SELECT id FROM plugin_marketplaces WHERE url LIKE '%acme/skills-%')`);
  await pool.query(`DELETE FROM skills WHERE user_id = $1`, [USER]);
  await pool.query(`DELETE FROM plugin_marketplaces WHERE url LIKE '%acme/skills-%'`);
  await pool.query(`DELETE FROM audit_log WHERE actor_id = $1`, [USER]);
};

const install = async (url: string) => {
  const { review, targetSha } = await previewSkillRepoInstall({ url, scope: "user", userId: USER, actor: ACTOR });
  return applySkillRepoInstall({
    url, scope: "user", userId: USER, actor: ACTOR, reviewHash: review.reviewHash, targetSha,
  });
};

const rowsFor = async (url: string) =>
  (await pool.query<{ id: string; synthetic: boolean }>(
    `SELECT id, synthetic FROM plugin_marketplaces WHERE url = $1`, [url])).rows;

run("skill repo installs keep their synthetic marketplace to themselves", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'sr test', 'sr@test.local', true, now(), now()) ON CONFLICT (id) DO NOTHING`, [USER]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [USER]);
  });

  beforeEach(async () => {
    await cleanup();
    load("toast");
  });

  it("does not add a member's personal install to everyone's Browse list", async () => {
    const before = (await listMarketplaces()).length;
    expect((await install(URL_A)).outcome).toBe("succeeded");
    // The row exists — the install points at it — but it is not a catalog anyone published.
    const rows = await rowsFor(URL_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].synthetic).toBe(true);
    expect(await listMarketplaces()).toHaveLength(before);
  });

  it("leaves nothing behind when the apply installs nothing", async () => {
    // A hash that no longer describes reality is refused BEFORE the claim — and the parent row
    // was already written by then, because the staging insert's FK needs it to exist.
    const { targetSha } = await previewSkillRepoInstall({ url: URL_A, scope: "user", userId: USER, actor: ACTOR });
    const outcome = await applySkillRepoInstall({
      url: URL_A, scope: "user", userId: USER, actor: ACTOR, reviewHash: "0".repeat(64), targetSha,
    });
    expect(outcome.outcome).toBe("stale");
    expect(await rowsFor(URL_A)).toHaveLength(0);
  });

  it("keeps the row when a SECOND install is already using it", async () => {
    // The undo is "only while nothing points at it": a successful install's row must survive
    // a later failed one, or the cleanup deletes a marketplace out from under a live install.
    expect((await install(URL_A)).outcome).toBe("succeeded");
    const outcome = await applySkillRepoInstall({
      url: URL_A, scope: "user", userId: USER, actor: ACTOR, reviewHash: "0".repeat(64), targetSha: "c".repeat(40),
    });
    expect(outcome.outcome).toBe("stale");
    expect(await rowsFor(URL_A)).toHaveLength(1);
  });

  it("does not take unrelated personal installs down with an admin's marketplace", async () => {
    expect((await install(URL_A)).outcome).toBe("succeeded");
    const [adminRow] = (await pool.query<{ id: string }>(
      `INSERT INTO plugin_marketplaces (id, url, name) VALUES ('srtest-admin-mk', $1, 'admin') RETURNING id`,
      ["https://github.com/acme/skills-b"])).rows;

    await deleteMarketplace(adminRow.id);

    // Different repo, different row: the personal install and its parent are untouched.
    expect(await rowsFor(URL_A)).toHaveLength(1);
    const installs = await pool.query(
      `SELECT id FROM plugin_installs WHERE marketplace_id = (SELECT id FROM plugin_marketplaces WHERE url = $1)`, [URL_A]);
    expect(installs.rows).toHaveLength(1);
    expect(await rowsFor(URL_B)).toHaveLength(0);
  });
});
