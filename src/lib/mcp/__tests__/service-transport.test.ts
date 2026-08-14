import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The storage + runtime gates for remote transports. A connector saved from an
 * `/sse` URL used to be written as `transport: "http"` and then skipped by
 * `listEnabledServerConfigs`, so it sat in Settings looking enabled while never
 * contributing a single tool to a turn.
 */
const rows = vi.hoisted(() => ({ mcp: [] as Record<string, unknown>[] }));
const writes = vi.hoisted(() => ({ values: [] as Record<string, unknown>[] }));

vi.mock("@/lib/db", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy"]) self[m] = () => self;
    // Awaiting the builder anywhere in the chain resolves to the rows.
    self.then = (res: (v: unknown) => unknown) => Promise.resolve(rows.mcp).then(res);
    return self;
  };
  // The writers are FENCED, so a mock has to model two things it did not before: a
  // `rowCount` (how the fence tells "written" from "refused") and `transaction` (a
  // plugin-owned insert serializes its rule under a lock on the owning install). A mock
  // that omits them makes every write look refused.
  const db = {
    select: () => chain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        writes.values.push(v);
        return {
          onConflictDoUpdate: () => Promise.resolve(),
          returning: () => Promise.resolve([{ id: v.id }]),
          then: (res: (x: unknown) => unknown) => Promise.resolve({ rowCount: 1 }).then(res),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve({ rowCount: 1 }) }) }),
    delete: () => ({ where: () => Promise.resolve({ rowCount: 1 }) }),
    execute: () => Promise.resolve({ rowCount: 1 }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db };
});
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock("@/lib/settings", () => ({
  getMasterKey: async () => "k",
  getBlockPrivateProviderUrls: async () => false,
}));
vi.mock("@/lib/net/ssrf", () => ({ assertSafeUrl: vi.fn(async () => {}) }));
vi.mock("@/lib/muted-resources", () => ({ mutedIds: async () => new Set<string>(), setMuted: vi.fn() }));

import { listEnabledServerConfigs, upsertServer, deleteServer } from "../service";
import { getCachedTools, setCachedTools, clearCachedTools } from "../tool-cache";

const row = (over: Record<string, unknown> = {}) => ({
  id: "s1", scope: "user", userId: "u1", projectId: null, name: "notion",
  transport: "sse", url: "https://mcp.notion.com/sse", command: null, args: null,
  secrets: null, authKind: "token", source: "manual", enabled: true,
  updatedAt: new Date(), ...over,
});

beforeEach(() => {
  rows.mcp = [];
  writes.values = [];
});

describe("listEnabledServerConfigs", () => {
  it("serves an sse connector to the run", async () => {
    rows.mcp = [row()];
    const out = await listEnabledServerConfigs("u1", null);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "notion", transport: "sse", url: "https://mcp.notion.com/sse" });
  });

  it("still skips a remote row with no URL", async () => {
    rows.mcp = [row({ url: null })];
    expect(await listEnabledServerConfigs("u1", null)).toHaveLength(0);
  });
});

describe("upsertServer", () => {
  it("stores the transport implied by an /sse URL", async () => {
    await upsertServer({ scope: "user", userId: "u1", projectId: null, name: "notion", url: "https://mcp.notion.com/sse" });
    expect(writes.values[0]).toMatchObject({ transport: "sse" });
  });

  it("stores http for an ordinary endpoint", async () => {
    await upsertServer({ scope: "user", userId: "u1", projectId: null, name: "tavily", url: "https://mcp.tavily.com/mcp/" });
    expect(writes.values[0]).toMatchObject({ transport: "http" });
  });

  it("lets an explicit transport override the URL guess", async () => {
    await upsertServer({
      scope: "user", userId: "u1", projectId: null, name: "odd",
      url: "https://host.example/sse", transport: "http",
    });
    expect(writes.values[0]).toMatchObject({ transport: "http" });
  });
});

describe("cached schemas follow the connector's config", () => {
  // Tools are declared to the model FROM the cache. An entry that survives a config
  // change describes a server we may no longer be talking to — the model would be
  // offered tools that no longer exist, and only find out by calling one.
  afterEach(() => clearCachedTools("s1"));

  it("drops the cached schemas when the connector is edited", async () => {
    rows.mcp = [row()]; // the row being edited must be findable, or upsert writes a NEW id
    setCachedTools("s1", [{ name: "old-tool" }]);
    await upsertServer({
      id: "s1", scope: "user", userId: "u1", projectId: null,
      name: "notion", url: "https://elsewhere.example/mcp",
    });
    expect(getCachedTools("s1")).toBeUndefined();
  });

  it("drops the cached schemas when the connector is deleted", async () => {
    setCachedTools("s1", [{ name: "old-tool" }]);
    await deleteServer("s1");
    expect(getCachedTools("s1")).toBeUndefined();
  });
});
