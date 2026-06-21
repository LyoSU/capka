import { describe, it, expect } from "vitest";
import { formatAvailableSkills, deriveDescription } from "../fmt";

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

  it("falls back to a body-derived summary when description is missing", () => {
    const out = formatAvailableSkills([
      { name: "shown", description: "yes" },
      { name: "command", description: null, body: "# Run the review\nDoes a thing." },
    ]);
    expect(out).toContain("- **shown**: yes");
    expect(out).toContain("- **command**: Run the review");
  });

  it("skips skills with neither description nor usable body", () => {
    const out = formatAvailableSkills([
      { name: "shown", description: "yes" },
      { name: "hidden", description: null },
      { name: "blank", description: null, body: "   \n\n" },
    ]);
    expect(out).toContain("shown");
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("blank");
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

describe("deriveDescription", () => {
  it("uses the first markdown heading", () => {
    expect(deriveDescription("# Title here\nbody")).toBe("Title here");
    expect(deriveDescription("## Nested\ntext")).toBe("Nested");
  });

  it("uses the first prose line when there is no heading", () => {
    expect(deriveDescription("Just a sentence.\nmore")).toBe("Just a sentence.");
  });

  it("strips leading frontmatter before deriving", () => {
    expect(deriveDescription("---\nname: x\n---\n# Real heading\n")).toBe("Real heading");
  });

  it("skips code fences and list/emphasis markers", () => {
    expect(deriveDescription("```\ncode\n```\n- **Important** step")).toBe("Important step");
  });

  it("returns empty for blank or missing bodies", () => {
    expect(deriveDescription("")).toBe("");
    expect(deriveDescription(null)).toBe("");
    expect(deriveDescription("   \n\n")).toBe("");
  });
});
