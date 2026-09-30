import { describe, it, expect } from "vitest";
import { workspaceSnapshotText } from "../run-context";

const file = (path: string) => ({ path, isDirectory: false });
const dir = (path: string) => ({ path, isDirectory: true });

describe("workspaceSnapshotText", () => {
  it("keeps the shallowest paths when there are more than it shows, and says how many it left out", () => {
    // A depth-first walk meets `a/` first and lists its whole subtree before the
    // rest of the top level: kept in walk order (or alphabetically), the cut would
    // be 50 files inside one folder and no sign of `report.docx` or `z/`.
    const deep = Array.from({ length: 60 }, (_, i) => file(`a/deep/f${String(i).padStart(2, "0")}.csv`));
    const text = workspaceSnapshotText([dir("a"), dir("a/deep"), ...deep, file("report.docx"), dir("z")], false)!;
    const lines = text.split("\n");
    expect(lines).toHaveLength(51);
    for (const p of ["a/", "a/deep/", "report.docx", "z/"]) expect(lines).toContain(JSON.stringify(p));
    // Shown in path order, so a folder sits above its contents.
    expect(lines.indexOf('"a/"')).toBeLessThan(lines.indexOf('"a/deep/"'));
    expect(lines.indexOf('"a/deep/"')).toBeLessThan(lines.indexOf('"report.docx"'));
    expect(lines.at(-1)).toBe("… and 14 more");
  });

  it("picks the same paths whatever order the listing arrived in", () => {
    const entries = [dir("b"), file("b/x.txt"), file("a.txt"), dir("c"), file("c/y.txt"), file("c/z.txt")];
    const once = workspaceSnapshotText(entries, false);
    expect(workspaceSnapshotText([...entries].reverse(), false)).toBe(once);
  });

  it("lists a path the top-level listing and the tree both returned once", () => {
    expect(workspaceSnapshotText([file("a.txt"), file("a.txt"), dir("b"), dir("b")], false)).toBe('"a.txt"\n"b/"');
  });

  it("says a cut-short listing is incomplete without claiming a count", () => {
    const text = workspaceSnapshotText([file("a.txt")], true)!;
    expect(text.split("\n").at(-1)).toBe("… and more (this listing is incomplete)");
  });

  it("leaves Capka's own folder out, and has nothing to say for an empty workspace", () => {
    expect(workspaceSnapshotText([dir(".capka"), file(".capka/output")], false)).toBeUndefined();
    expect(workspaceSnapshotText([dir(".capka"), file("a.txt")], false)).toBe('"a.txt"');
  });
});
