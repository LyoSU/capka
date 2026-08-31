import { describe, it, expect } from "vitest";

import { HANDLE_RE, makeHandleMap, type HandleTarget } from "../handles";

/**
 * Task 7's handle block, moved here whole (Ruling 15): `resolveTopic`'s handle arm
 * consumes `HANDLE_RE` in slice 2's Task 3, so the module and its test land with it.
 */
describe("handles", () => {
  const target = (over: Partial<HandleTarget> = {}): HandleTarget => ({
    kind: "n",
    spaceId: "space-1",
    nodeId: "node-1",
    ...over,
  });

  it("mints a handle the shape gate accepts, and resolves it back to the same target", () => {
    const map = makeHandleMap();
    const t = target();
    const h = map.mint(t);
    expect(h).toBe("n1");
    expect(HANDLE_RE.test(h)).toBe(true);
    expect(map.resolve(h)).toEqual(t);
  });

  it("numbers each kind independently, from 1", () => {
    const map = makeHandleMap();
    expect(map.mint(target({ kind: "m", nodeId: "c1" }))).toBe("m1");
    expect(map.mint(target({ kind: "n", nodeId: "n1" }))).toBe("n1");
    expect(map.mint(target({ kind: "m", nodeId: "c2" }))).toBe("m2");
    expect(map.mint(target({ kind: "f", nodeId: "s1", fragmentId: "fr1" }))).toBe("f1");
  });

  it("gives one target ONE handle, however often it is minted", () => {
    const map = makeHandleMap();
    const first = map.mint(target());
    expect(map.mint(target())).toBe(first);
    // A different fragment of the same node is a different target, not the same one.
    expect(map.mint(target({ kind: "f", fragmentId: "fr1" }))).not.toBe(first);
  });

  it("resolves a fabricated, malformed or never-minted handle to null, not a throw", () => {
    const map = makeHandleMap();
    map.mint(target());
    for (const h of ["n2", "m1", "x1", "n0", "note-1", "", "n1 "]) {
      expect(map.resolve(h)).toBeNull();
    }
  });

  it("is RUN-LOCAL: a handle minted by one map is void in another", () => {
    const a = makeHandleMap();
    const b = makeHandleMap();
    const h = a.mint(target());
    expect(b.resolve(h)).toBeNull();
    // And the second run is free to hand the same STRING to a different row, which is
    // exactly why a handle from a previous run may never be honoured.
    expect(b.mint(target({ nodeId: "some-other-node" }))).toBe(h);
  });

  it("refuses to mint past the number space its own regex accepts", () => {
    const map = makeHandleMap();
    for (let i = 1; i <= 9999; i++) map.mint(target({ nodeId: `node-${i}` }));
    expect(HANDLE_RE.test(map.resolve("n9999") ? "n9999" : "")).toBe(true);
    expect(() => map.mint(target({ nodeId: "node-10000" }))).toThrow(/exhausted/);
  });
});
