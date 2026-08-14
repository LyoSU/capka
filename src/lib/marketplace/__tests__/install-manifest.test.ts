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
// The POLARITY inverted when the manual fence stopped being one statement. It used to yield a
// row when the write was ALLOWED, so `rowCount: 1` meant "go ahead"; now it locks the owning
// install and then probes for `applyState.status = 'applying'`, so rows mean "somebody is
// applying" and ZERO is the permissive answer. `rowCount: 1` therefore flipped these five from
// passing to fenced without a single line of their own changing — a reminder that a stub which
// answers every query the same way is deciding a security verdict by accident.
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
    // No apply is in flight in any of these tests, so the fence's probe finds nothing.
    execute: async () => ({ rowCount: 0, rows: [] }),
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db };
});

import { installPlugin } from "../install";
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

const run = () => installPlugin({ marketplaceId: "mk1", pluginName: "plug", installedBy: "u1" });

/**
 * The write that PUBLISHES the committed view — the LAST manifest write, not the first.
 *
 * A first install now writes the column twice: a reservation that claims the row's identity
 * before a single resource is routed, then the commit. Reading `writes[0]` used to be the same
 * thing and no longer is, so these assertions name what they mean.
 */
const committed = () => {
  const manifests = h.writes.filter((w) => w.op !== "route");
  return readStoredManifest(manifests[manifests.length - 1].manifest);
};

describe("what an apply commits", () => {
  it("stores the surface beside the inventory under schemaVersion 2", async () => {
    await run();
    const written = committed();
    expect(written.inventory.connectors).toEqual(["api"]);
    expect(written.inventory.skills).toEqual(["writer"]);
    expect(written.installSurface?.completeness).toBe("derived");
    expect(written.installSurface?.connectors.map((c) => c.originKey)).toEqual([".mcp.json#api"]);
    expect(written.installSurface?.skills.map((s) => s.name)).toEqual(["writer"]);
  });

  it("starts a first install at revision 1, so 0 stays the value only a first claim matches", async () => {
    await run();
    expect(committed().committedRevision).toBe(1);
  });

  it("reserves the row BEFORE routing a single resource", async () => {
    await run();
    // Routing first and inserting afterwards let two concurrent first installs each write
    // skills and connectors under their own `catalog:<id>`, with only one insert surviving the
    // partial unique index — leaving the loser's rows owned by an install that does not exist:
    // skipped by every prune, invisible to `uninstallPlugin`, reachable from no screen.
    expect(h.writes[0].op).toBe("insert");
    expect(h.writes.findIndex((w) => w.op === "route")).toBeGreaterThan(0);
    // And the reservation is a RESERVATION: it publishes nothing, so `committedRevision` stays
    // at the one value only a first claim can match.
    expect(readStoredManifest(h.writes[0].manifest).committedRevision).toBe(0);
    expect(readStoredManifest(h.writes[0].manifest).neverCommitted).toBe(true);
  });

  it("bumps the revision on a re-install", async () => {
    h.state.existing = {
      id: "i1", commitSha: "c".repeat(40),
      manifest: { schemaVersion: 2, inventory: { skills: [], connectors: [], ignored: [], notes: [] },
                  installSurface: null, committedRevision: 4 },
    };
    await run();
    expect(committed().committedRevision).toBe(5);
  });

  it("upgrades a legacy row lazily: 0 → 1, with no backfill pass", async () => {
    // A legacy row stored the inventory at the top level and has no counter. It becomes
    // V2 on its next apply and not before — nothing migrates rows in bulk.
    h.state.existing = {
      id: "i1", commitSha: "c".repeat(40),
      manifest: { skills: ["writer"], connectors: [], ignored: [], notes: [], displayName: "Fx" },
    };
    await run();
    const written = committed();
    expect(written.committedRevision).toBe(1);
    expect(written.installSurface).not.toBeNull();
  });

  it("refuses to renumber a V2 row whose counter went missing", async () => {
    // Silently restarting the count would repair the symptom and destroy the evidence,
    // and 1 is a value a stale apply could then match.
    h.state.existing = {
      id: "i1", commitSha: "c".repeat(40),
      manifest: { schemaVersion: 2, inventory: { skills: [], connectors: [], ignored: [], notes: [] }, installSurface: null },
    };
    await expect(run()).rejects.toThrow(/non-finite committedRevision/);
  });

  it("never writes a raw InstallManifest to the column any more", async () => {
    // The regression this guards: a write site that skipped the builder would look fine
    // and leave the next upgrade with no baseline to compare against. Checked across EVERY
    // manifest write rather than just the first — the reservation is a second write site, and
    // it goes through `reservedManifest` for exactly this reason.
    await run();
    const manifests = h.writes.filter((w) => w.op !== "route");
    expect(manifests.map((w) => w.op)).toEqual(["insert", "update"]);
    for (const w of manifests) {
      expect((w.manifest as { schemaVersion?: number }).schemaVersion).toBe(2);
    }
  });
});
