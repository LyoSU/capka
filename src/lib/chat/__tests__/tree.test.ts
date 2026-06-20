import { describe, it, expect } from "vitest";
import { activePath, descendToLeaf, siblingId, type TreeNode } from "../tree";

// Pure graph tests — no DB, so they run in the normal suite. `createdAt`
// increments per node to give a deterministic sibling order.
let clock = 0;
const n = (id: string, parentId: string | null): TreeNode => ({
  id,
  parentId,
  createdAt: new Date(++clock * 1000),
});

describe("conversation tree", () => {
  it("returns a linear chat root → leaf with no alternatives", () => {
    const rows = [n("u1", null), n("a1", "u1"), n("u2", "a1"), n("a2", "u2")];
    const path = activePath(rows, "a2");
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(path.every((p) => p.siblingCount === 1)).toBe(true);
  });

  it("follows the active leaf through an edited branch and exposes ‹ i/N ›", () => {
    // u1 → a1 → u2 → a2   (original)
    //            ↘ u2b → a2b   (u2 edited: sibling under a1)
    const rows = [
      n("u1", null), n("a1", "u1"),
      n("u2", "a1"), n("a2", "u2"),
      n("u2b", "a1"), n("a2b", "u2b"),
    ];
    const path = activePath(rows, "a2b");
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1", "u2b", "a2b"]);
    // u2b is the 2nd of two siblings under a1.
    const edited = path.find((p) => p.node.id === "u2b")!;
    expect(edited.siblingCount).toBe(2);
    expect(edited.siblingIndex).toBe(1);
    // Switching back to the original branch shows the first version.
    const orig = activePath(rows, "a2").find((p) => p.node.id === "u2")!;
    expect(orig.siblingIndex).toBe(0);
    expect(orig.siblingCount).toBe(2);
  });

  it("descends to the newest child at each step", () => {
    const rows = [n("u1", null), n("a1", "u1"), n("a1b", "u1"), n("u2", "a1b")];
    // a1b is newer than a1, and u2 hangs off a1b.
    expect(descendToLeaf(rows, "u1")).toBe("u2");
  });

  it("falls back to the newest branch when the active pointer is missing", () => {
    const rows = [n("u1", null), n("a1", "u1"), n("a1b", "u1")];
    const path = activePath(rows, null);
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1b"]); // newest leaf
  });

  it("falls back when the active pointer is stale (points at a deleted node)", () => {
    const rows = [n("u1", null), n("a1", "u1")];
    const path = activePath(rows, "ghost");
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1"]);
  });

  it("returns nothing for an empty chat", () => {
    expect(activePath([], "whatever")).toEqual([]);
  });

  it("steps between siblings and stops at the edges", () => {
    const rows = [n("u1", null), n("a", "u1"), n("b", "u1"), n("c", "u1")];
    expect(siblingId(rows, "a", "next")).toBe("b");
    expect(siblingId(rows, "b", "next")).toBe("c");
    expect(siblingId(rows, "c", "next")).toBe(null); // at the end
    expect(siblingId(rows, "a", "prev")).toBe(null); // at the start
    expect(siblingId(rows, "b", "prev")).toBe("a");
    expect(siblingId(rows, "ghost", "next")).toBe(null);
  });
});
