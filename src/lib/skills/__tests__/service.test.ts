import { describe, it, expect } from "vitest";
import { dedupeByPrecedence } from "../service";
import type { SkillInfo } from "../types";

const s = (over: Partial<SkillInfo>): SkillInfo => ({
  id: over.name ?? "id",
  scope: "system",
  name: "x",
  description: null,
  body: "",
  enabled: true,
  source: "manual",
  ...over,
});

describe("dedupeByPrecedence", () => {
  it("project beats user beats system on name collision", () => {
    const out = dedupeByPrecedence([
      s({ id: "sys", scope: "system", name: "dup" }),
      s({ id: "usr", scope: "user", name: "dup" }),
      s({ id: "prj", scope: "project", name: "dup" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("prj");
  });

  it("keeps distinct names from all tiers", () => {
    const out = dedupeByPrecedence([
      s({ id: "a", scope: "system", name: "a" }),
      s({ id: "b", scope: "user", name: "b" }),
    ]);
    expect(out.map((x) => x.name).sort()).toEqual(["a", "b"]);
  });

  it("input order does not affect the winner", () => {
    const out = dedupeByPrecedence([
      s({ id: "prj", scope: "project", name: "dup" }),
      s({ id: "sys", scope: "system", name: "dup" }),
    ]);
    expect(out[0].id).toBe("prj");
  });
});
