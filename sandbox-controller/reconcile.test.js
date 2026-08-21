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

  it("recreates a running container built by an older spec", async () => {
    // The rollout half of a hardening fix: mount options and caps are fixed at
    // CREATE time, so a container started before the fix keeps the weak posture
    // until something tears it down. Compute goes, the workspace row stays.
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = {
      list: async () => [{ sessionId: "s1", handle: "c1", running: true, spec: "old", networkMode: "none" }],
      destroy,
    };
    const out = await reconcile({ store, backend, currentSpec: () => "new" });
    expect(out.outdated).toContain("s1");
    expect(out.kept).not.toContain("s1");
    expect(destroy).toHaveBeenCalledWith("c1");
    expect(store._m.has("s1")).toBe(true);        // workspace survives
    expect(store._m.get("s1").handle).toBeNull(); // compute reclaimed
  });

  it("treats a container with NO spec label as outdated", async () => {
    // It predates the label, which is precisely the container a posture fix has to
    // reach — adopting it would keep the weakest sandboxes alive the longest.
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: true }], destroy };
    const out = await reconcile({ store, backend, currentSpec: () => "new" });
    expect(out.outdated).toContain("s1");
    expect(destroy).toHaveBeenCalledWith("c1");
  });

  // The hole the fingerprint alone cannot close: it is computed FROM the mode each
  // container carries, so one on the wrong network is compared against its own
  // posture and agrees with itself.
  it("destroys a container that is on the wrong network, even with a matching spec", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = {
      list: async () => [{ sessionId: "s1", handle: "c1", running: true, spec: "hash-bridge", networkMode: "bridge" }],
      destroy,
    };
    // An allowlist was turned on: a networked sandbox now belongs on the gated
    // network, so the one still sitting on the open bridge has to go.
    const out = await reconcile({
      store, backend,
      currentSpec: (net) => `hash-${net}`,
      desiredMode: (recorded) => (recorded === "none" ? "none" : "capka-sandbox-egress"),
    });
    expect(out.outdated).toContain("s1");
    expect(destroy).toHaveBeenCalledWith("c1");
  });

  it("leaves a closed sandbox alone when egress is off for everyone", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = {
      list: async () => [{ sessionId: "s1", handle: "c1", running: true, spec: "hash-none", networkMode: "none" }],
      destroy,
    };
    const out = await reconcile({
      store, backend,
      currentSpec: (net) => `hash-${net}`,
      desiredMode: () => "none",
    });
    expect(out.kept).toContain("s1");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps a running container whose spec matches, per network mode", async () => {
    // Egress adds NET_ADMIN/NET_RAW, so the two modes are different postures and the
    // fingerprint is asked for the mode the container was actually built with.
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = {
      list: async () => [{ sessionId: "s1", handle: "c1", running: true, spec: "hash-bridge", networkMode: "bridge" }],
      destroy,
    };
    const out = await reconcile({ store, backend, currentSpec: (net) => `hash-${net}` });
    expect(out.kept).toContain("s1");
    expect(destroy).not.toHaveBeenCalled();
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
