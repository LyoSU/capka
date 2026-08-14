import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What an apply COMMITS to `pluginInstalls.manifest`. The interesting part is not the
 * inventory (Phase A already pins that) but the surface stored beside it and the
 * revision counter, because a later claim's CAS compares that counter — a missed bump
 * would let an apply planned against an older committed state win
 * (docs/plugin-install-review-spec.md §4, §7).
 */
const h = vi.hoisted(() => ({
  state: {
    tree: [] as { path: string; type: "blob" | "tree"; sha: string }[],
    files: {} as Record<string, string>,
    existing: null as { id: string; commitSha: string | null; manifest: unknown } | null,
  },
  // `route` entries are resource writes, recorded in the same list as the manifest writes so
  // their ORDER against each other is observable — which is the whole point of the reservation.
  writes: [] as { op: "insert" | "update" | "route"; manifest: unknown }[],
}));

vi.mock("../fetch", () => ({
  ghFetch: async () => (() => { throw new Error("no network"); }) as unknown as typeof fetch,
  resolveCommit: async () => ({ sha: "c".repeat(40), date: null, message: null }),
  ghTree: async () => h.state.tree,
  ghRaw: async (_o: string, _r: string, _s: string, path: string) => h.state.files[path] ?? null,
  diffTrees: vi.fn(),
}));
vi.mock("@/lib/mcp/oauth/detect", () => ({ detectAuthKind: async () => "token" }));
vi.mock("@/lib/net/ssrf", () => ({ preflightUrl: async () => "allowed" }));
vi.mock("@/lib/settings", () => ({
  getBlockPrivateProviderUrls: async () => false,
  getMasterKey: async () => "a".repeat(64),
}));
vi.mock("@/lib/mcp/service", () => ({
  upsertServer: async () => { h.writes.push({ op: "route", manifest: null }); return "srv-remote"; },
  upsertStdioServer: async () => { h.writes.push({ op: "route", manifest: null }); return "srv-stdio"; },
  setEnabled: async () => {},
  deleteServer: vi.fn(),
}));
vi.mock("@/lib/skills/service", () => ({
  ingestSkill: async () => { h.writes.push({ op: "route", manifest: null }); },
  deleteSkill: vi.fn(),
}));
// Fencing the writers means a mock must model `execute` (the fence's row count) and
// `transaction` (the row and its child files are now one unit). A mock missing either makes
// every fenced write look REFUSED — which is how these five tests failed the moment the fence
// landed, and why the mock has to grow with it.
//
// The permissive `rowCount` DEPENDS ON THE AUTHORITY, and a stub that answers every query the
// same way is therefore deciding a security verdict by accident:
//
//   - `plugin-apply` — the statement selects the install row only while it is still applying
//     under OUR operation, so A ROW means "yes, this is ours" and 1 is permissive. That is the
//     authority `writeReviewedPlan` carries, so these tests need 1.
//   - `manual` — locks the owning install unconditionally, then probes for
//     `applyState.status = 'applying'`, so A ROW means "somebody else is applying" and 0 is
//     permissive. The reverse.
//
// This file has now been flipped by that difference twice: once when the manual fence stopped
// being a single statement, and once when its subject moved from `installPlugin` (manual) to
// `writeReviewedPlan` (plugin-apply). Both times not a line of the tests' own logic changed.
vi.mock("@/lib/db", () => {
  const db: Record<string, unknown> = {
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        // The marketplace row lookup and the install lookup both land here; the shape of
        // the requested columns tells them apart.
        where: () => {
          const rows = cols && "manifest" in cols && "commitSha" in cols
            ? (h.state.existing ? [h.state.existing] : [])
            : [{ id: "mk1", url: "https://github.com/acme/plug", catalog: [
                { name: "plug", source: ".", installable: true, kind: "plugin" },
              ] }];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
    insert: () => ({ values: async (v: { manifest: unknown }) => { h.writes.push({ op: "insert", manifest: v.manifest }); } }),
    update: () => ({ set: (v: { manifest: unknown }) => ({ where: async () => { h.writes.push({ op: "update", manifest: v.manifest }); } }) }),
    delete: () => ({ where: async () => {} }),
    // The operation holds a live claim, which is what `plugin-apply` asks the fence to confirm.
    execute: async () => ({ rowCount: 1, rows: [] }),
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db };
});

import { writeReviewedPlan } from "../install";
import { observePluginPlan } from "../observe";
import { buildPluginPlan } from "../plan";
import { readStoredManifest } from "../manifest-store";

const FIXTURE = {
  ".mcp.json": JSON.stringify({ mcpServers: { api: { url: "https://api.example.com/mcp" } } }),
  "skills/writer/SKILL.md": "---\nname: writer\n---\nBody",
};

beforeEach(() => {
  h.writes.length = 0;
  h.state.existing = null;
  h.state.files = FIXTURE;
  h.state.tree = Object.keys(FIXTURE).map((path) => ({ path, type: "blob" as const, sha: "s" }));
});

/**
 * `writeReviewedPlan` is now the ONE writer that routes a plugin's resources. `installPlugin`
 * used to be the subject here; it and `installSkillRepo` are gone, because they were the last
 * unreviewed path to these rows and their only caller now goes through the barrier.
 *
 * The subject of these assertions did not change: `committedManifest` still builds the value,
 * and it is easier to see here — `writeReviewedPlan` RETURNS the manifest rather than writing
 * it, because `finalizeApply` is what publishes it under its own compare-and-set.
 */
const run = async (priorManifest?: unknown) => {
  const plan = await buildPluginPlan({ owner: "acme", repo: "plug", ref: "HEAD", subdir: "" });
  const obs = await observePluginPlan(plan, { blockPrivate: false });
  return writeReviewedPlan({
    operationId: "op_1", installId: "i1", plan, observations: obs,
    target: { scope: "system", userId: null, projectId: null },
    priorManifest, fallbackVersion: "c".repeat(7),
  });
};

/**
 * The committed view is now the RETURN VALUE, not a write to watch for.
 *
 * `writeReviewedPlan` hands the manifest back and `finalizeApply` publishes it under its own
 * compare-and-set — so until the claim resolves, the runtime still sees the previous committed
 * state. That is the invariant, and it reads directly here instead of through the write log.
 */
const committed = (m: Record<string, unknown>) => readStoredManifest(m);

describe("what an apply commits", () => {
  it("stores the surface beside the inventory under schemaVersion 2", async () => {
    const written = committed(await run());
    expect(written.inventory.connectors).toEqual(["api"]);
    expect(written.inventory.skills).toEqual(["writer"]);
    expect(written.installSurface?.completeness).toBe("derived");
    expect(written.installSurface?.connectors.map((c) => c.originKey)).toEqual([".mcp.json#api"]);
    expect(written.installSurface?.skills.map((s) => s.name)).toEqual(["writer"]);
  });

  it("starts a first install at revision 1, so 0 stays the value only a first claim matches", async () => {
    expect(committed(await run()).committedRevision).toBe(1);
  });

  it("does NOT publish the manifest itself — finalize does, under its own CAS", async () => {
    // The routing writes resources and bundled files, and returns the view. Publishing it here
    // would make an apply visible before its claim resolved, so a lost lease would leave the
    // runtime reading a state no operation ever committed.
    const returned = await run();
    expect((returned as { schemaVersion?: number }).schemaVersion).toBe(2);
    expect(h.writes.some((w) => w.op === "route")).toBe(true);
    // The only row write it makes is the pin + files, in one fenced transaction — never the
    // committed manifest.
    expect(h.writes.filter((w) => w.op === "insert" || w.op === "update").map((w) => w.manifest))
      .not.toContain(returned);
  });

  it("bumps the revision on a re-install", async () => {
    const prior = { schemaVersion: 2, inventory: { skills: [], connectors: [], ignored: [], notes: [] },
                    installSurface: null, committedRevision: 4 };
    expect(committed(await run(prior)).committedRevision).toBe(5);
  });

  it("upgrades a legacy row lazily: 0 → 1, with no backfill pass", async () => {
    // A legacy row stored the inventory at the top level and has no counter. It becomes
    // V2 on its next apply and not before — nothing migrates rows in bulk.
    const written = committed(await run({ skills: ["writer"], connectors: [], ignored: [], notes: [], displayName: "Fx" }));
    expect(written.committedRevision).toBe(1);
    expect(written.installSurface).not.toBeNull();
  });

  it("refuses to renumber a V2 row whose counter went missing", async () => {
    // Silently restarting the count would repair the symptom and destroy the evidence,
    // and 1 is a value a stale apply could then match.
    await expect(run({ schemaVersion: 2, inventory: { skills: [], connectors: [], ignored: [], notes: [] }, installSurface: null }))
      .rejects.toThrow(/non-finite committedRevision/);
  });

  it("never produces a raw InstallManifest any more", async () => {
    // The regression this guards: a write site that skipped the builder would look fine and
    // leave the next upgrade with no baseline to compare against.
    const returned = await run();
    expect((returned as { schemaVersion?: number }).schemaVersion).toBe(2);
    expect(returned).toHaveProperty("inventory");
    expect(returned).toHaveProperty("installSurface");
  });
});
