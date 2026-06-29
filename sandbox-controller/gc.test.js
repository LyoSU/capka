import { describe, it, expect, vi } from "vitest";
import { gcOrphanWorkspaces, findOverQuota, reapStaleWorkspaces, quotaWarnings, reclaimRegenerable } from "./gc.js";

describe("reapStaleWorkspaces", () => {
  it("deletes row + dir for workspaces idle beyond the TTL, stopping live ones", async () => {
    const rows = [
      { sessionId: "stale-live", userId: "u1", handle: "c1", lastActivity: 0 },
      { sessionId: "stale-stopped", userId: "u1", handle: null, lastActivity: 0 },
      { sessionId: "fresh", userId: "u1", handle: "c2", lastActivity: 9_999 },
    ];
    const deleted = [];
    const removed = [];
    const store = { all: async () => rows, delete: async (id) => deleted.push(id) };
    const backend = { destroy: vi.fn() };
    const workspace = { remove: async (u, s) => removed.push(`${u}/${s}`) };
    const out = await reapStaleWorkspaces({ store, backend, workspace, ttlMs: 1000, now: 10_000 });
    expect(out.reaped).toBe(2);
    expect(deleted.sort()).toEqual(["stale-live", "stale-stopped"]);
    expect(removed.sort()).toEqual(["u1/stale-live", "u1/stale-stopped"]);
    expect(backend.destroy).toHaveBeenCalledTimes(1); // only the live one had a handle
    expect(backend.destroy).toHaveBeenCalledWith("c1");
  });

  it("keeps workspaces used within the TTL", async () => {
    const store = { all: async () => [{ sessionId: "fresh", userId: "u1", handle: null, lastActivity: 9_500 }] };
    const remove = vi.fn();
    const out = await reapStaleWorkspaces({ store, backend: { destroy: vi.fn() }, workspace: { remove }, ttlMs: 1000, now: 10_000 });
    expect(out.reaped).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("gcOrphanWorkspaces", () => {
  // Mirror the real store: get(id) resolves to the row if present.
  const storeOf = (rows) => ({ all: async () => rows, get: async (id) => rows.find((r) => r.sessionId === id) ?? null });

  it("removes orphaned workspaces older than grace", async () => {
    const store = storeOf([{ sessionId: "live" }]);
    const remove = vi.fn();
    const listOnDisk = async () => [
      { userId: "u1", sessionId: "live", mtimeMs: 0 },
      { userId: "u1", sessionId: "dead", mtimeMs: 0 },
    ];
    await gcOrphanWorkspaces({ store, workspace: { remove }, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).toHaveBeenCalledWith("u1", "dead");
    expect(remove).not.toHaveBeenCalledWith("u1", "live");
  });

  it("keeps young orphans within grace", async () => {
    const store = storeOf([]);
    const remove = vi.fn();
    const listOnDisk = async () => [{ userId: "u1", sessionId: "new", mtimeMs: 9_500 }];
    await gcOrphanWorkspaces({ store, workspace: { remove }, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("does NOT remove a workspace that became live between the snapshot and the remove (TOCTOU)", async () => {
    // Snapshot has no row for "racing"; by the time we re-check, get() returns it
    // (a session was created mid-pass). The re-check must spare its fresh files.
    const store = { all: async () => [], get: async (id) => (id === "racing" ? { sessionId: "racing" } : null) };
    const remove = vi.fn();
    const listOnDisk = async () => [{ userId: "u1", sessionId: "racing", mtimeMs: 0 }];
    await gcOrphanWorkspaces({ store, workspace: { remove }, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("findOverQuota", () => {
  const store = { all: async () => [
    { sessionId: "small", userId: "u1" },
    { sessionId: "big", userId: "u2" },
  ] };
  const workspace = { size: async (_u, sid) => (sid === "big" ? 600 : 100) };

  it("reports only sessions exceeding the limit (reporting, not destroying)", async () => {
    const over = await findOverQuota({ store, workspace, limitBytes: 500 });
    expect(over).toEqual([{ sessionId: "big", userId: "u2", bytes: 600 }]);
  });

  it("returns nothing when all workspaces are under the limit", async () => {
    expect(await findOverQuota({ store, workspace, limitBytes: 1000 })).toEqual([]);
  });
});

describe("quotaWarnings", () => {
  const over = (ids) => ids.map((id) => ({ sessionId: id, userId: "u", bytes: 1 }));

  it("warns only newly-over workspaces, staying quiet on repeat ticks", () => {
    const warned = new Set();
    expect(quotaWarnings(over(["a", "b"]), warned).map((o) => o.sessionId)).toEqual(["a", "b"]);
    expect(quotaWarnings(over(["a", "b"]), warned)).toEqual([]); // already warned this tick
  });

  it("re-warns after a workspace drops under quota and crosses again", () => {
    const warned = new Set();
    quotaWarnings(over(["a"]), warned);                          // first crossing → warned
    expect(quotaWarnings(over([]), warned)).toEqual([]);         // recovered → cleared, no log
    expect(quotaWarnings(over(["a"]), warned).map((o) => o.sessionId)).toEqual(["a"]); // crosses again
  });
});

describe("reclaimRegenerable", () => {
  // active-over: container live → never touch (deps may be in use mid-task)
  // idle-under: under quota → no reason to prune
  // fresh-over: over quota but recently active → leave the user's setup alone
  // stale-over: stopped + idle + over quota → safe to strip regenerable deps
  const rows = [
    { sessionId: "active-over", userId: "u", handle: "c", lastActivity: 0 },
    { sessionId: "idle-under", userId: "u", handle: null, lastActivity: 0 },
    { sessionId: "fresh-over", userId: "u", handle: null, lastActivity: 9_500 },
    { sessionId: "stale-over", userId: "u", handle: null, lastActivity: 0 },
  ];

  it("prunes regenerable dirs only from stopped, idle, over-quota workspaces", async () => {
    const pruned = new Set();
    const sizeBefore = { "active-over": 9999, "idle-under": 10, "fresh-over": 9999, "stale-over": 9999 };
    const store = { all: async () => rows };
    const workspace = { size: async (_u, sid) => (pruned.has(sid) ? 100 : sizeBefore[sid]) };
    const prune = vi.fn(async (_u, sid) => { pruned.add(sid); });
    const out = await reclaimRegenerable({ store, workspace, limitBytes: 500, idleMs: 1000, prune, now: 10_000 });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith("u", "stale-over");
    expect(out.reclaimed).toBe(9999 - 100); // freed = size before − size after
  });

  it("does nothing when no workspace qualifies", async () => {
    const store = { all: async () => [{ sessionId: "live", userId: "u", handle: "c", lastActivity: 0 }] };
    const prune = vi.fn();
    const out = await reclaimRegenerable({ store, workspace: { size: async () => 9999 }, limitBytes: 500, idleMs: 1000, prune, now: 10_000 });
    expect(prune).not.toHaveBeenCalled();
    expect(out.reclaimed).toBe(0);
  });
});
