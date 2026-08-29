import { describe, it, expect } from "vitest";
import { selectTouchedFiles, type WorkspaceEntry, type ToolWindow } from "../artifacts";

const T = (iso: string) => new Date(iso).getTime();

const file = (path: string, modifiedAt: string | null, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  path,
  isDirectory: false,
  size: 10,
  modifiedAt,
  ...extra,
});

// One tool ran 10:00:00 → 10:00:06.
const WINDOW: ToolWindow[] = [{ start: T("2026-08-12T10:00:00Z"), end: T("2026-08-12T10:00:06Z") }];

describe("selectTouchedFiles — what the turn actually touched", () => {
  it("keeps a file written while a tool was running", () => {
    const out = selectTouchedFiles([file("report.xlsx", "2026-08-12T10:00:04Z")], WINDOW, []);
    expect(out).toEqual(["report.xlsx"]);
  });

  // The whole point of windowing: chats in one project share a workspace, so a
  // parallel chat or a nightly automation must not have its file credited here.
  it("drops a file changed outside every tool window", () => {
    const out = selectTouchedFiles(
      [file("someone-elses.csv", "2026-08-12T09:58:00Z"), file("nightly.xlsx", "2026-08-12T10:05:00Z")],
      WINDOW,
      [],
    );
    expect(out).toEqual([]);
  });

  it("checks every window, not just the first", () => {
    const windows: ToolWindow[] = [
      { start: T("2026-08-12T10:00:00Z"), end: T("2026-08-12T10:00:02Z") },
      { start: T("2026-08-12T10:00:30Z"), end: T("2026-08-12T10:00:40Z") },
    ];
    const out = selectTouchedFiles([file("late.pdf", "2026-08-12T10:00:35Z")], windows, []);
    expect(out).toEqual(["late.pdf"]);
  });

  // The gap BETWEEN two tool calls belongs to the model thinking, not to us.
  it("drops a file changed in the gap between two tool calls", () => {
    const windows: ToolWindow[] = [
      { start: T("2026-08-12T10:00:00Z"), end: T("2026-08-12T10:00:02Z") },
      { start: T("2026-08-12T10:00:30Z"), end: T("2026-08-12T10:00:40Z") },
    ];
    const out = selectTouchedFiles([file("between.txt", "2026-08-12T10:00:15Z")], windows, []);
    expect(out).toEqual([]);
  });

  it("ignores directories and entries with no timestamp", () => {
    const out = selectTouchedFiles(
      [
        file("out", "2026-08-12T10:00:03Z", { isDirectory: true }),
        file("mystery.bin", null),
        file("real.txt", "2026-08-12T10:00:03Z"),
      ],
      WINDOW,
      [],
    );
    expect(out).toEqual(["real.txt"]);
  });

  // Tier one already shows what the model named; repeating it is the "two
  // presentations of one file" bug this design exists to avoid.
  it("excludes files already listed as named artifacts", () => {
    const out = selectTouchedFiles(
      [file("Report Q3.xlsx", "2026-08-12T10:00:03Z"), file("calc.py", "2026-08-12T10:00:02Z")],
      WINDOW,
      ["Report Q3.xlsx"],
    );
    expect(out).toEqual(["calc.py"]);
  });

  // The final result is written last, so newest-first puts it at the front even
  // though this tier is folded away.
  it("orders newest first", () => {
    const out = selectTouchedFiles(
      [
        file("first.py", "2026-08-12T10:00:01Z"),
        file("last.xlsx", "2026-08-12T10:00:05Z"),
        file("middle.csv", "2026-08-12T10:00:03Z"),
      ],
      WINDOW,
      [],
    );
    expect(out).toEqual(["last.xlsx", "middle.csv", "first.py"]);
  });

  it("caps the list so one runaway turn cannot bloat the message row", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      file(`f${String(i).padStart(2, "0")}.txt`, "2026-08-12T10:00:03Z"),
    );
    expect(selectTouchedFiles(many, WINDOW, []).length).toBeLessThanOrEqual(12);
  });

  // Same traversal guard the text-derived tier applies: these paths reach the
  // download endpoint, and a listing is not automatically trustworthy input.
  it("rejects paths that would escape the workspace", () => {
    const out = selectTouchedFiles(
      [file("../../etc/passwd", "2026-08-12T10:00:03Z"), file("ok.txt", "2026-08-12T10:00:03Z")],
      WINDOW,
      [],
    );
    expect(out).toEqual(["ok.txt"]);
  });

  // Every capture log is written BY a tool call, so its mtime lands inside a
  // window by construction — the one thing this tier cannot filter on. A turn that
  // named nothing then promoted it to the primary artifact tile.
  it("drops Capka's own scratch files, which always fall inside a window", () => {
    const out = selectTouchedFiles(
      [
        file(".capka/output/1787483216992635450-124.log", "2026-08-12T10:00:05Z"),
        file(".capka/jobs/ab12/exitcode", "2026-08-12T10:00:04Z"),
        file(".capka/view/preview.png", "2026-08-12T10:00:04Z"),
        file("Report Q3.xlsx", "2026-08-12T10:00:03Z"),
      ],
      WINDOW,
      [],
    );
    expect(out).toEqual(["Report Q3.xlsx"]);
  });

  it("keeps a user's own dotfile — the rule is our directory, not any dot", () => {
    const out = selectTouchedFiles([file(".gitignore", "2026-08-12T10:00:03Z")], WINDOW, []);
    expect(out).toEqual([".gitignore"]);
  });

  it("returns nothing when the turn ran no tools at all", () => {
    expect(selectTouchedFiles([file("a.txt", "2026-08-12T10:00:03Z")], [], [])).toEqual([]);
  });

  // Filesystem timestamps round and the controller's clock is not ours, so an
  // exact-boundary write must not be lost to a sub-second discrepancy.
  it("tolerates a small clock/rounding skew at the window edges", () => {
    const out = selectTouchedFiles([file("edge.txt", "2026-08-12T10:00:06.400Z")], WINDOW, []);
    expect(out).toEqual(["edge.txt"]);
  });
});
