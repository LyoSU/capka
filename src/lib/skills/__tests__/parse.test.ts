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
});
