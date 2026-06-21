import { describe, it, expect, vi } from "vitest";
import { reconcile } from "./reconcile.js";

function fakeStore(records) {
  const m = new Map(records.map((r) => [r.sessionId, r]));
  return { all: async () => [...m.values()], delete: async (id) => m.delete(id), _m: m };
}

describe("reconcile (§14 table)", () => {
  it("keeps running sessions present in both", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: true }], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.kept).toContain("s1");
    expect(backend.destroy).not.toHaveBeenCalled();
  });

  it("deletes DB record with no backend container (zombie)", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => [], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.removedRecords).toContain("s1");
    expect(store._m.has("s1")).toBe(false);
  });

  it("destroys orphan container with no DB record", async () => {
    const store = fakeStore([]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s9", handle: "c9", running: true }], destroy };
    const out = await reconcile({ store, backend });
    expect(out.destroyedOrphans).toContain("s9");
    expect(destroy).toHaveBeenCalledWith("c9");
  });

  it("destroys + removes stopped container with a DB record", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: false }], destroy };
    const out = await reconcile({ store, backend });
    expect(destroy).toHaveBeenCalledWith("c1");
    expect(store._m.has("s1")).toBe(false);
  });

  it("propagates backend.list() failure (no record deletion on transient error)", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => { throw new Error("daemon down"); }, destroy: vi.fn() };
    await expect(reconcile({ store, backend })).rejects.toThrow(/daemon down/);
    expect(store._m.has("s1")).toBe(true);
  });
});
