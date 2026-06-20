import { describe, it, expect } from "vitest";
import { describeStep } from "../steps";

// A translator stub that echoes "key" or "key(json-values)" so tests can assert
// which message key was chosen and what was interpolated, without loading i18n.
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${JSON.stringify(values)})` : key;

describe("describeStep — categories", () => {
  it("classifies file tools", () => {
    expect(describeStep(t, "write_file", { path: "/workspace/a/logo.svg" }).category).toBe("file");
    expect(describeStep(t, "str_replace", { path: "app.tsx" }).category).toBe("file");
    expect(describeStep(t, "read_file", { path: "data.csv" }).category).toBe("file");
    expect(describeStep(t, "list_files").category).toBe("file");
  });

  it("uses the file basename in the label", () => {
    expect(describeStep(t, "write_file", { path: "/workspace/deep/logo.svg" }).label)
      .toContain("logo.svg");
  });

  it("unifies execution tools under one category", () => {
    expect(describeStep(t, "execute_bash", { command: "ls" }).category).toBe("exec");
    expect(describeStep(t, "execute_python", { code: "print(1)" }).category).toBe("exec");
    expect(describeStep(t, "execute_node", { code: "1" }).category).toBe("exec");
  });

  it("carries the bash command as the dim detail", () => {
    expect(describeStep(t, "execute_bash", { command: "npm run build" }).detail).toBe("npm run build");
  });

  it("classifies workspace search", () => {
    expect(describeStep(t, "search_files", { pattern: "TODO" }).category).toBe("search");
  });

  it("classifies web search and page fetch via heuristics", () => {
    expect(describeStep(t, "brave_web_search", { query: "gas prices" }).category).toBe("search");
    expect(describeStep(t, "tavily_search", { q: "x" }).category).toBe("search");
    expect(describeStep(t, "fetch_url", { url: "https://x" }).category).toBe("browse");
  });
});

describe("describeStep — MCP connectors", () => {
  it("recognises mcp__<server>__<tool> as its own category", () => {
    const d = describeStep(t, "mcp__notion__search", { query: "Q2" });
    expect(d.category).toBe("mcp");
  });

  it("exposes a brand for the connector with a human label", () => {
    const d = describeStep(t, "mcp__notion__search");
    expect(d.brand).toBeDefined();
    expect(d.brand!.label).toBe("Notion");
  });

  it("maps multi-word known connectors to a proper brand label", () => {
    expect(describeStep(t, "mcp__google_drive__upload").brand!.label).toBe("Google Drive");
    expect(describeStep(t, "mcp__gmail__send").brand!.label).toBe("Gmail");
  });

  it("falls back to a title-cased server name for unknown connectors", () => {
    const d = describeStep(t, "mcp__acme_crm__create_lead");
    expect(d.category).toBe("mcp");
    expect(d.brand!.label).toBe("Acme Crm");
  });

  it("surfaces the connector action in the label", () => {
    const d = describeStep(t, "mcp__notion__search_pages");
    expect(d.label.toLowerCase()).toContain("notion");
    expect(d.label.toLowerCase()).toContain("search pages");
  });
});

describe("describeStep — skills", () => {
  it("classifies the skill tool as its own category", () => {
    const d = describeStep(t, "skill", { name: "seo-audit" });
    expect(d.category).toBe("skill");
  });

  it("uses the skill name in the label", () => {
    const d = describeStep(t, "skill", { name: "seo-audit" });
    // name is passed through the translator values
    expect(JSON.stringify(d)).toContain("seo-audit");
  });
});

describe("describeStep — unknown tools", () => {
  it("falls back to 'other' with a prettified name", () => {
    const d = describeStep(t, "some_weird_tool");
    expect(d.category).toBe("other");
    expect(d.label).toContain("Some weird tool");
  });

  it("shows a neutral working label while the name is still streaming", () => {
    // getToolName() hands us "unknown" before the real name arrives — never
    // render a literal "Unknown…".
    for (const sentinel of ["unknown", "Unknown", ""]) {
      const d = describeStep(t, sentinel);
      expect(d.category).toBe("other");
      expect(d.activeLabel).toBe("working");
      expect(d.label).not.toContain("Unknown");
    }
  });
});
