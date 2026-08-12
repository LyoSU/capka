import { describe, it, expect } from "vitest";
import { splitTouchedByMention } from "../artifacts";

describe("splitTouchedByMention — models name files however they like", () => {
  // The capable case: a full /workspace/ path. Already handled by
  // extractWorkspacePaths, but must not regress here.
  it("matches a file named with its full workspace path", () => {
    const out = splitTouchedByMention(["report.xlsx", "calc.py"], "Готово — /workspace/report.xlsx зібрано.");
    expect(out.mentioned).toEqual(["report.xlsx"]);
    expect(out.rest).toEqual(["calc.py"]);
  });

  // The whole reason this exists: a weaker model writes the bare name, which the
  // /workspace/ regex cannot see, and every touched file would be promoted as if
  // the reply had named nothing.
  it("matches a bare filename mentioned in prose", () => {
    const out = splitTouchedByMention(["report.xlsx", "calc.py"], "Зберіг усе в report.xlsx, перевірте будь ласка.");
    expect(out.mentioned).toEqual(["report.xlsx"]);
    expect(out.rest).toEqual(["calc.py"]);
  });

  it("matches a file inside a nested folder by its basename", () => {
    const out = splitTouchedByMention(["out/2026/Звіт Q3.xlsx"], "Звіт Q3.xlsx готовий.");
    expect(out.mentioned).toEqual(["out/2026/Звіт Q3.xlsx"]);
  });

  it("ignores case differences a model introduces in prose", () => {
    const out = splitTouchedByMention(["Report.XLSX"], "результат у report.xlsx");
    expect(out.mentioned).toEqual(["Report.XLSX"]);
  });

  it("puts everything in rest when the reply names nothing", () => {
    const out = splitTouchedByMention(["report.xlsx", "calc.py"], "Готово!");
    expect(out.mentioned).toEqual([]);
    expect(out.rest).toEqual(["report.xlsx", "calc.py"]);
  });

  it("keeps the given order within each side", () => {
    const out = splitTouchedByMention(
      ["a.xlsx", "b.py", "c.csv", "d.log"],
      "Зробив a.xlsx та c.csv.",
    );
    expect(out.mentioned).toEqual(["a.xlsx", "c.csv"]);
    expect(out.rest).toEqual(["b.py", "d.log"]);
  });

  // A name too short to be distinctive would match incidental prose, and the cost
  // of a false promotion is junk in tier one — the exact thing tier two prevents.
  it("does not promote on an implausibly short basename", () => {
    const out = splitTouchedByMention(["a.c"], "точка a.c на графіку");
    expect(out.mentioned).toEqual([]);
  });

  it("handles an empty reply and an empty list without throwing", () => {
    expect(splitTouchedByMention([], "текст")).toEqual({ mentioned: [], rest: [] });
    expect(splitTouchedByMention(["x.txt"], "")).toEqual({ mentioned: [], rest: ["x.txt"] });
  });
});
