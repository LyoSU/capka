import { describe, it, expect } from "vitest";
import { formatAvailableSkills } from "../fmt";

describe("formatAvailableSkills", () => {
  it("renders a sorted markdown list", () => {
    const out = formatAvailableSkills([
      { name: "zebra", description: "Z" },
      { name: "alpha", description: "A" },
    ]);
    expect(out).toContain("## Available Skills");
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("zebra"));
    expect(out).toContain("- **alpha**: A");
  });

  it("skips skills without a description", () => {
    const out = formatAvailableSkills([
      { name: "shown", description: "yes" },
      { name: "hidden", description: null },
    ]);
    expect(out).toContain("shown");
    expect(out).not.toContain("hidden");
  });

  it("returns empty string when nothing is describable", () => {
    expect(formatAvailableSkills([{ name: "x", description: null }])).toBe("");
    expect(formatAvailableSkills([])).toBe("");
  });

  it("is deterministic regardless of input order (cache stability)", () => {
    const a = formatAvailableSkills([
      { name: "b", description: "B" },
      { name: "a", description: "A" },
    ]);
    const b = formatAvailableSkills([
      { name: "a", description: "A" },
      { name: "b", description: "B" },
    ]);
    expect(a).toBe(b);
  });

  it("truncates very long descriptions", () => {
    const out = formatAvailableSkills([{ name: "x", description: "d".repeat(900) }]);
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("…");
  });
});
