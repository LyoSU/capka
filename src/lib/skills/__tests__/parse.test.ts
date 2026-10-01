import { describe, it, expect } from "vitest";
import { parseSkillMarkdown } from "../parse";
import { SkillParseError } from "../types";

const md = (fm: string, body = "Do the thing.") => `---\n${fm}\n---\n${body}`;

describe("parseSkillMarkdown", () => {
  it("parses a valid skill", () => {
    const r = parseSkillMarkdown(md(`name: my-skill\ndescription: Does a thing`));
    expect(r.name).toBe("my-skill");
    expect(r.description).toBe("Does a thing");
    expect(r.body).toBe("Do the thing.");
    expect(r.frontmatter.name).toBe("my-skill");
  });

  it("preserves unknown frontmatter (lenient & total)", () => {
    const r = parseSkillMarkdown(md(`name: x\ndescription: y\nversion: 2.0.0\nallowed-tools: Bash(git *)`));
    expect(r.frontmatter.version).toBe("2.0.0");
    expect(r.frontmatter["allowed-tools"]).toBe("Bash(git *)");
  });

  it("recovers from an unquoted colon in description (issue #8331)", () => {
    const r = parseSkillMarkdown(md(`name: x\ndescription: Use when: the user asks`));
    expect(r.name).toBe("x");
    expect(r.description).toContain("Use when");
  });

  it("keeps $-patterns literal when it re-quotes a colon value", () => {
    const r = parseSkillMarkdown(md("name: x\ndescription: Use when: a $& b $` c $' d"));
    expect(r.description).toBe("Use when: a $& b $` c $' d");
  });

  it("rejects a missing or invalid name", () => {
    expect(() => parseSkillMarkdown(md(`description: no name`))).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(md(`name: Has Spaces\ndescription: y`))).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(md(`name: UPPER\ndescription: y`))).toThrow(SkillParseError);
  });

  it("treats description as optional", () => {
    const r = parseSkillMarkdown(md(`name: bare`));
    expect(r.description).toBeUndefined();
  });

  it("rejects an over-long description", () => {
    const long = "a".repeat(1025);
    expect(() => parseSkillMarkdown(md(`name: x\ndescription: ${long}`))).toThrow(SkillParseError);
  });

  it("refuses oversized frontmatter before parsing it, closed or not", () => {
    const notes = `notes: ${"a".repeat(64 * 1024)}`;
    expect(() => parseSkillMarkdown(md(`name: x\n${notes}`))).toThrow(/frontmatter exceeds/);
    expect(() => parseSkillMarkdown(`---\nname: x\n${notes}\n`)).toThrow(/frontmatter exceeds/);
    // Only the frontmatter is bounded: a long body still parses.
    expect(parseSkillMarkdown(md(`name: x`, "b".repeat(128 * 1024))).name).toBe("x");
  });

  it("refuses JavaScript frontmatter without evaluating it", () => {
    const g = globalThis as { __skillProbe?: number };
    delete g.__skillProbe;
    for (const tag of ["js", "JS", "javascript"]) {
      const raw = `---${tag}\n{ name: "x", probe: (globalThis.__skillProbe = 1) }\n---\nbody`;
      expect(() => parseSkillMarkdown(raw)).toThrow(SkillParseError);
    }
    expect(g.__skillProbe).toBeUndefined();
  });

  it("refuses frontmatter whose aliases expand past the bound", () => {
    // 8 levels of 10-way aliases: about 400 bytes in, 10^8 nodes out.
    const levels = [`a0: &a0 [${Array(10).fill("x").join(", ")}]`];
    for (let i = 1; i < 8; i++) levels.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`);
    expect(() => parseSkillMarkdown(md(`name: x\n${levels.join("\n")}`))).toThrow(/too large once expanded/);
    // A long scalar repeated by alias, still under the byte cap.
    const long = `s: &s ${"a".repeat(30_000)}\nr: [${Array(10).fill("*s").join(", ")}]`;
    expect(() => parseSkillMarkdown(md(`name: x\n${long}`))).toThrow(/too large once expanded/);
  });

  it("bounds an alias array under excerpt_separator before gray-matter expands it", () => {
    // gray-matter would join this key's value into one string inside matter() itself.
    const levels = [`a0: &a0 [${Array(10).fill("x").join(", ")}]`];
    for (let i = 1; i < 9; i++) levels.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`);
    const raw = md(`name: x\n${levels.join("\n")}\nexcerpt_separator: *a8`);
    const started = performance.now();
    expect(() => parseSkillMarkdown(raw)).toThrow(/too large once expanded/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
