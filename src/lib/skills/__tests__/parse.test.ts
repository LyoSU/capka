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
    const notes = `notes: ${"a".repeat(8 * 1024)}`;
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

  it("refuses YAML anchors and aliases before they can expand", () => {
    const anchorsRefused = /can't use YAML anchors or aliases/;
    // 8 levels of 10-way aliases: about 400 bytes in, 10^8 nodes out.
    const levels = [`a0: &a0 [${Array(10).fill("x").join(", ")}]`];
    for (let i = 1; i < 8; i++) levels.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`);
    expect(() => parseSkillMarkdown(md(`name: x\n${levels.join("\n")}`))).toThrow(anchorsRefused);
    // js-yaml joins an aliased array used as a mapping key into one string while it parses.
    const key = `s: &s ${"a".repeat(1000)}\na: &a [${Array(500).fill("*s").join(", ")}]\nk:\n  *a : 1`;
    const started = performance.now();
    expect(() => parseSkillMarkdown(md(`name: x\n${key}`))).toThrow(anchorsRefused);
    expect(performance.now() - started).toBeLessThan(500);
    // gray-matter would stringify this key's value inside matter() itself.
    expect(() => parseSkillMarkdown(md(`name: x\nsep: &e [a, b]\nexcerpt_separator: *e`))).toThrow(anchorsRefused);
    // Even an anchor nothing refers to.
    expect(() => parseSkillMarkdown(md(`name: x\nversion: &v 1`))).toThrow(anchorsRefused);
  });

  it("refuses any frontmatter language but YAML, as a parse error", () => {
    for (const tag of ["toml", "coffee", "__proto__", "constructor", "toString", "json"]) {
      expect(() => parseSkillMarkdown(`---${tag}\nname: x\n---\nbody`), tag).toThrow(SkillParseError);
    }
    expect(parseSkillMarkdown(`---yaml\nname: x\n---\nbody`).name).toBe("x");
    expect(parseSkillMarkdown(`--- YML\nname: x\n---\nbody`).name).toBe("x");
  });

  it("reports broken YAML as a parse error, not a raw exception", () => {
    expect(() => parseSkillMarkdown(md(`name: x\nlist: [a, b`))).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(md(`name: x\nfn: !!js/function "function () {}"`))).toThrow(SkillParseError);
  });

  it("parses a block of blank lines under the cap quickly", () => {
    const started = performance.now();
    expect(() => parseSkillMarkdown(`---\n${"\n".repeat(8000)}name: x\n---\nbody`)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("reads the frontmatter language the way gray-matter does, whatever the line endings", () => {
    const g = globalThis as { __skillProbe?: number };
    delete g.__skillProbe;
    // gray-matter takes the language up to the first \r?\n and trims it, so a lone CR
    // after the dashes still selects an engine.
    for (const open of ["---\rjson\n", "---\rjson\r\n", "--- \r\rjson \n", "﻿---\rjson\n"]) {
      expect(() => parseSkillMarkdown(`${open}{"name": "x"}\n---\nbody`), JSON.stringify(open)).toThrow(
        "SKILL.md frontmatter must be YAML",
      );
    }
    expect(() =>
      parseSkillMarkdown(`---\rjs\n{ name: "x", probe: (globalThis.__skillProbe = 1) }\n---\nbody`),
    ).toThrow("SKILL.md frontmatter must be YAML");
    expect(g.__skillProbe).toBeUndefined();
    expect(parseSkillMarkdown(`---\r\nname: x\r\n---\r\nbody`).name).toBe("x");
    expect(parseSkillMarkdown(`---yaml\r\nname: x\r\n---\r\nbody`).name).toBe("x");
  });

  it("refuses a name of any shape as a parse error, quoting at most 64 chars of it", () => {
    for (const fm of ["name:\n  toString: x", "name:\n  valueOf: 1\n  toString: 2", "name: [{ toString: x }]"]) {
      expect(() => parseSkillMarkdown(md(fm)), fm).toThrow(SkillParseError);
    }
    const long = "a".repeat(5000);
    let message = "";
    try {
      parseSkillMarkdown(md(`name: ${long}`));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`"${"a".repeat(64)}…"`);
    expect(message).not.toContain("a".repeat(65));
  });

  it("recovers an unquoted colon in a CRLF or BOM file just as in an LF one", () => {
    const fm = "name: x\ndescription: Use when: the user asks";
    for (const raw of [md(fm).replace(/\n/g, "\r\n"), `﻿${md(fm)}`, `﻿${md(fm).replace(/\n/g, "\r\n")}`]) {
      const r = parseSkillMarkdown(raw);
      expect(r.description, JSON.stringify(raw)).toBe("Use when: the user asks");
      expect(r.body).toBe("Do the thing.");
    }
  });
});
