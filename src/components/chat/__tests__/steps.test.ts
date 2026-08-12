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

  // The object acted on goes in `detail` (the sunken mono well), never spliced
  // into the sentence — same grammar `execute_bash` has always used. The label
  // stays a whole phrase in the user's language so the eye can read it and skip
  // the machine token in one move.
  it("carries the file basename as the detail, not inside the label", () => {
    const d = describeStep(t, "write_file", { path: "/workspace/deep/logo.svg" });
    expect(d.detail).toBe("logo.svg");
    expect(d.label).not.toContain("logo.svg");
    expect(d.activeLabel).not.toContain("logo.svg");
  });

  it("uses the same label for every file of one action, whatever the name", () => {
    const a = describeStep(t, "str_replace", { path: "a.tsx" });
    const b = describeStep(t, "str_replace", { path: "b/c/долгое имя.csv" });
    expect(a.label).toBe(b.label);
    expect(b.detail).toBe("долгое имя.csv");
  });

  // Args stream in progressively: the path can be missing on the first render.
  it("omits the detail entirely when no path has arrived yet", () => {
    const d = describeStep(t, "read_file", {});
    expect(d.detail).toBeUndefined();
    expect(d.label).toBeTruthy();
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

  // A glob/regex is a machine token, so it belongs in the well like a filename.
  it("carries the workspace search pattern as the detail", () => {
    const d = describeStep(t, "search_files", { pattern: "TODO" });
    expect(d.detail).toBe("TODO");
    expect(d.label).not.toContain("TODO");
  });

  // A web query is prose, not a token: in a mono well it reads as broken type.
  // It stays inside the sentence, which is why this tool keeps its own key.
  it("keeps a web search query in the sentence rather than the well", () => {
    const d = describeStep(t, "brave_web_search", { query: "ціни на бензин" });
    expect(d.detail).toBeUndefined();
    expect(JSON.stringify(d.label)).toContain("ціни на бензин");
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

  // MCP servers commonly prefix every tool with their own name, which our branded
  // prefix then repeats ("Silpo · Silpo get my shopping cart").
  it("does not say the connector's name twice", () => {
    expect(describeStep(t, "mcp__silpo__Silpo_get_my_shopping_cart").label).toBe("Silpo · Get my shopping cart");
    expect(describeStep(t, "mcp__notion__notion-search").label).toBe("Notion · Search");
  });

  it("matches the prefix regardless of case, separators or a brand alias", () => {
    // label is "Google Drive"; the tool spells it as one word, and `gdrive` is an
    // alias for the same connector.
    expect(describeStep(t, "mcp__google_drive__GoogleDrive_list_files").label).toBe("Google Drive · List files");
    expect(describeStep(t, "mcp__gdrive__gdrive_list_files").label).toBe("Google Drive · List files");
  });

  it("keeps a tool that merely starts with the same letters", () => {
    // "Notes" is not "Notion", so nothing may be stripped.
    expect(describeStep(t, "mcp__notion__Notes_export").label).toBe("Notion · Notes export");
  });

  it("shows the connector alone when the tool's whole name is the connector", () => {
    expect(describeStep(t, "mcp__silpo__silpo").label).toBe("Silpo");
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

  // A skill name is a slug, so it reads as a token and belongs in the well.
  it("carries the skill name as the detail", () => {
    const d = describeStep(t, "skill", { name: "seo-audit" });
    expect(d.detail).toBe("seo-audit");
    expect(d.label).not.toContain("seo-audit");
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
