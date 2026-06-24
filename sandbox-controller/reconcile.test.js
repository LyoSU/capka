import { describe, it, expect, vi } from "vitest";
import { reconcile } from "./reconcile.js";

function fakeStore(records) {
  const m = new Map(records.map((r) => [r.sessionId, r]));
  return {
    all: async () => [...m.values()],
    delete: async (id) => m.delete(id),
    // Reconcile reclaims compute (handle) but NEVER deletes a workspace row.
    setStopped: async (id) => { const r = m.get(id); if (r) r.handle = null; },
    _m: m,
  };
}

describe("reconcile (compute vs. workspace lifecycle)", () => {
  it("keeps running sessions present in both", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: true }], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.kept).toContain("s1");
    expect(backend.destroy).not.toHaveBeenCalled();
  });

  it("stops (not deletes) a DB record whose container vanished — workspace survives", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => [], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.stopped).toContain("s1");
    expect(store._m.has("s1")).toBe(true);        // row kept
    expect(store._m.get("s1").handle).toBeNull(); // compute reclaimed
  });

  it("destroys the dead container but keeps the row when backend reports it stopped", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: false }], destroy };
    const out = await reconcile({ store, backend });
    expect(destroy).toHaveBeenCalledWith("c1");
    expect(out.stopped).toContain("s1");
    expect(store._m.has("s1")).toBe(true);
    expect(store._m.get("s1").handle).toBeNull();
  });

  it("leaves an already-stopped workspace (null handle) untouched", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: null }]);
    const backend = { list: async () => [], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.stopped).toContain("s1");
    expect(store._m.has("s1")).toBe(true);
    expect(backend.destroy).not.toHaveBeenCalled();
  });

  it("destroys orphan container with no DB record", async () => {
    const store = fakeStore([]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s9", handle: "c9", running: true }], destroy };
    const out = await reconcile({ store, backend });
    expect(out.destroyedOrphans).toContain("s9");
    expect(destroy).toHaveBeenCalledWith("c9");
  });

  it("propagates backend.list() failure (no record touched on transient error)", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => { throw new Error("daemon down"); }, destroy: vi.fn() };
    await expect(reconcile({ store, backend })).rejects.toThrow(/daemon down/);
    expect(store._m.get("s1").handle).toBe("c1");
  });
});
