import { describe, it, expect } from "vitest";
import { editStatsFromParts, editKey, lineCount } from "../edit-stats";

describe("lineCount", () => {
  it("counts lines the way a diff does", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\n")).toBe(1);
    expect(lineCount("one\ntwo\n")).toBe(2);
    expect(lineCount("\n")).toBe(1);
  });
});

describe("editStatsFromParts", () => {
  const write = (path: string, lines: number) => ({ type: "tool-write_file", output: { success: true, path, lines } });
  const replace = (path: string, added: number, removed: number) => ({ type: "tool-str_replace", output: { success: true, path, added, removed } });

  it("sums the writes and replacements per file, under one key for relative and absolute paths", () => {
    const stats = editStatsFromParts([write("report.py", 40), replace("/workspace/report.py", 6, 2), write("out/data.csv", 12)]);
    expect(stats.get("report.py")).toEqual({ added: 46, removed: 2 });
    expect(stats.get(editKey("/workspace/out/data.csv"))).toEqual({ added: 12, removed: 0 });
  });

  it("skips failures, other tools, and results from before the tools reported sizes", () => {
    const stats = editStatsFromParts([
      { type: "tool-write_file", output: { success: false, error: "disk full", path: "a.txt" } },
      { type: "tool-write_file", output: { success: true, path: "old.txt" } },
      { type: "tool-execute_bash", output: { output: "echo", exitCode: 0 } },
      { type: "dynamic-tool", toolName: "str_replace", output: { success: true, path: "b.txt", added: 1, removed: 1 } },
    ]);
    expect([...stats.keys()]).toEqual(["b.txt"]);
  });

  it("falls back to the call's own path when the result carries none", () => {
    const stats = editStatsFromParts([{ type: "tool-write_file", input: { path: "x.md" }, output: { success: true, lines: 3 } }]);
    expect(stats.get("x.md")).toEqual({ added: 3, removed: 0 });
  });
});
