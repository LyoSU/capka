import { describe, it, expect } from "vitest";
import { describeStep, describeInvocation } from "../steps";

// A translator stub that echoes "key" or "key(json-values)" so tests can assert
// which message key was chosen and what was interpolated, without loading i18n.
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${JSON.stringify(values)})` : key;

/**
 * L1 — the settled label of a memory step is an ATTEMPT, never an outcome.
 *
 * `describeStep` is chosen from the tool NAME alone and never sees the result, while
 * these three calls settle as pending, conflict, retired, refused or not-found far more
 * often than as done: since the authority cutover a proposal always waits for the
 * person, and `memory_forget` always refuses. "Saved to memory" over a refusal is not a
 * cosmetic slip — it is the security gate's outcome misreported in the one place
 * someone reviewing an incident would look.
 *
 * These assertions are on the KEYS, not on English words, because the copy is
 * translated and a key is what the two locale files agree on. If an output-aware label
 * is ever added here, it has to map every policy state, not only the happy one.
 */
describe("describeStep — a memory step names the attempt, not the outcome", () => {
  const SUCCESS_KEYS = ["savedToMemory", "updatedMemory", "removedFromMemory"];

  it.each([
    ["memory_propose", "memoryProposal"],
    ["memory_update", "memoryCorrection"],
    ["memory_forget", "memoryRemoval"],
  ])("%s settles as %s", (tool, key) => {
    const d = describeStep(t, tool, {});
    expect(d.label).toBe(key);
    expect(SUCCESS_KEYS).not.toContain(d.label);
  });

  it("keeps memory steps off the web-search branch", () => {
    // `memory_search` contains "search", and the heuristic below it rendered a globe —
    // the one step where a user's trust depends on knowing WHERE the agent looked.
    expect(describeStep(t, "memory_search", { query: "acme" }).iconKey).toBe("bookmark");
    for (const tool of ["memory_propose", "memory_update", "memory_forget"]) {
      expect(describeStep(t, tool, {}).iconKey).toBe("bookmark");
    }
  });
});

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
    const b = describeStep(t, "str_replace", { path: "b/c/a long file name.csv" });
    expect(a.label).toBe(b.label);
    expect(b.detail).toBe("a long file name.csv");
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
    const d = describeStep(t, "brave_web_search", { query: "petrol prices near me" });
    expect(d.detail).toBeUndefined();
    expect(JSON.stringify(d.label)).toContain("petrol prices near me");
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

// ── describeInvocation ───────────────────────────────────────────────────────
//
// What the model actually SENT, for the "Invocation" block above the result.
// `describeStep` answers "what did it do" in the user's language; this answers
// "with what", verbatim. The two are deliberately separate: the sentence must
// stay readable prose, and a 40-line Python program is not prose.

describe("describeInvocation", () => {
  it("returns the code for execute_python, which had no visible arguments at all", () => {
    expect(describeInvocation("execute_python", { code: "print(1)" })).toEqual({
      kind: "code", lang: "python", text: "print(1)", titleKey: "code",
    });
  });

  it("labels execute_node as javascript so the highlighter picks a grammar", () => {
    expect(describeInvocation("execute_node", { code: "console.log(1)" })).toMatchObject({ lang: "javascript" });
  });

  // The chip truncates to 48 chars (`clip`), which is right for a one-line row
  // and wrong for the block — the whole point of the block is that nothing is
  // hidden. A pipeline is mostly its tail.
  it("keeps the bash command whole, unlike the truncated row chip", () => {
    const long = `find . -name '*.tmp' ${"-o -name '*.bak' ".repeat(8)}-print`;
    expect(describeInvocation("execute_bash", { command: long })).toEqual({
      kind: "code", lang: "bash", text: long, titleKey: "command",
    });
    expect(long.length).toBeGreaterThan(48);
  });

  it("shows a file write as its content, typed by the path's extension", () => {
    expect(describeInvocation("write_file", { path: "/workspace/a/run.py", content: "x = 1" })).toEqual({
      kind: "code", lang: "python", text: "x = 1", titleKey: "content",
    });
  });

  it("falls back to no language when the extension is unknown, rather than guessing", () => {
    expect(describeInvocation("write_file", { path: "notes.zzz", content: "hi" })).toMatchObject({ lang: "" });
  });

  // str_replace hands us both sides explicitly (old_str/new_str), so the diff is
  // free — no diffing algorithm, no library.
  it("renders an edit as a two-sided diff, not a blob", () => {
    expect(describeInvocation("str_replace", { path: "a.ts", old_str: "const a = 1", new_str: "const a = 2" })).toEqual({
      kind: "diff", lang: "typescript", before: "const a = 1", after: "const a = 2", titleKey: "changes",
    });
  });

  // These already put their one argument in the row's chip. Repeating it in a
  // code block below would be the same token twice, three lines apart.
  it("stays silent for tools whose only argument is already the row's chip", () => {
    expect(describeInvocation("read_file", { path: "a.csv" })).toBeNull();
    expect(describeInvocation("view_file", { path: "a.pdf" })).toBeNull();
    expect(describeInvocation("search_files", { pattern: "*.ts" })).toBeNull();
    expect(describeInvocation("list_files", { path: "/workspace" })).toBeNull();
  });

  // `manage` is the settings tool; its arguments are internal plumbing and its
  // result already renders as a card or a localized one-liner.
  it("stays silent for manage, whose arguments are internal", () => {
    expect(describeInvocation("manage", { action: "set", key: "x" })).toBeNull();
  });

  // Generic arguments render as readable label/value FIELDS, not a JSON code
  // block: the audience is a non-technical reader, and `{"query": "..."}` with
  // syntax highlighting is a developer artifact. The verbatim JSON is kept
  // alongside for the folded "technical details" — nothing is lost, it is
  // demoted.
  it("shows an unknown or MCP tool's arguments as readable fields, JSON kept alongside", () => {
    const inv = describeInvocation("mcp__notion__create_page", { title: "Q3", parent: "db_1" });
    expect(inv).toMatchObject({ kind: "fields", titleKey: "params" });
    if (!inv || inv.kind !== "fields") throw new Error("expected fields");
    expect(inv.entries).toEqual([
      { label: "title", value: "Q3", mono: false },
      { label: "parent", value: "db_1", mono: false },
    ]);
    expect(inv.json).toContain('"title": "Q3"');
  });

  // THE streaming case. Args arrive character by character, so every tool call
  // is briefly `{}`. Returning an empty block there would flash an empty frame
  // into the timeline on every single step — the exact jitter this work removes.
  it("returns null while arguments are still streaming, so no empty block flashes", () => {
    expect(describeInvocation("execute_python", {})).toBeNull();
    expect(describeInvocation("execute_bash", { command: "" })).toBeNull();
    expect(describeInvocation("mcp__notion__create_page", {})).toBeNull();
    expect(describeInvocation("write_file", { path: "a.py" })).toBeNull();
    expect(describeInvocation("execute_python", undefined)).toBeNull();
  });

  // A file created empty on purpose is a real action with a real result. Its
  // content is "" — which is not the same as "not arrived yet".
  it("distinguishes a deliberately empty file from arguments that have not arrived", () => {
    expect(describeInvocation("write_file", { path: "a.py", content: "" })).toEqual({
      kind: "code", lang: "python", text: "", titleKey: "content",
    });
  });
});

// ── the full path, for opening the file ──────────────────────────────────────

describe("describeStep — the file behind the step", () => {
  // The chip shows the basename (readable); Quick Look needs the whole path.
  it("carries the full path alongside the basename chip", () => {
    const d = describeStep(t, "write_file", { path: "/workspace/deep/logo.svg" });
    expect(d.file).toBe("/workspace/deep/logo.svg");
    expect(d.detail).toBe("logo.svg");
  });

  it("carries the path for every tool that acts on one concrete file", () => {
    expect(describeStep(t, "str_replace", { path: "a/b.tsx" }).file).toBe("a/b.tsx");
    expect(describeStep(t, "read_file", { path: "a/b.csv" }).file).toBe("a/b.csv");
    expect(describeStep(t, "view_file", { path: "a/b.pdf" }).file).toBe("a/b.pdf");
  });

  // A directory has nothing to open in a file viewer, and a half-streamed path
  // would resolve to the wrong file — or to a prefix of one.
  it("omits the path for a directory listing and while the path is still streaming", () => {
    expect(describeStep(t, "list_files", { path: "/workspace" }).file).toBeUndefined();
    expect(describeStep(t, "write_file", {}).file).toBeUndefined();
  });
});

// The heading over the invocation block. Decided HERE rather than in the
// component, because the alternative is the component re-deriving it by sniffing
// the language string — the same fragile `name.includes(...)` pattern this work
// removes from ToolDetails. A key, not a word: the UI is localized.
describe("describeInvocation — what to call the block", () => {
  it("names each kind of invocation in the user's terms, not the tool's", () => {
    const key = (tool: string, args: Record<string, unknown>) => {
      const inv = describeInvocation(tool, args);
      return inv && inv.titleKey;
    };
    expect(key("execute_bash", { command: "ls" })).toBe("command");
    expect(key("execute_python", { code: "x" })).toBe("code");
    expect(key("execute_node", { code: "x" })).toBe("code");
    expect(key("write_file", { path: "a.py", content: "x" })).toBe("content");
    expect(key("str_replace", { path: "a.py", old_str: "x", new_str: "y" })).toBe("changes");
    expect(key("mcp__notion__create_page", { title: "Q3" })).toBe("params");
  });
});

// The clamp is applied by the UI, which can only take a prefix of what it is
// handed. So the ORDER of the fields here decides what survives being clamped —
// and on any call big enough to be clamped, the long field IS the payload.
// `{content: <2 MB>, path: "/srv/report.csv"}` serialized in argument order shows
// two megabytes of body and never reaches the path, naming nothing the reader
// could act on. Cheapest-first inverts that: identifiers are short, bodies long.
describe("describeInvocation — which arguments survive a clamp", () => {
  const fields = (tool: string, args: Record<string, unknown>) => {
    const inv = describeInvocation(tool, args);
    if (!inv || inv.kind !== "fields") throw new Error("expected a fields invocation");
    return inv;
  };

  it("puts a short identifier ahead of a long body, whatever order they arrived in", () => {
    const inv = fields("mcp__files__put", { content: "x".repeat(5000), path: "/srv/report.csv" });
    expect(inv.entries[0].label).toBe("path");
    expect(inv.json.indexOf('"path"')).toBeLessThan(inv.json.indexOf('"content"'));
    expect(inv.json.indexOf('"path"')).toBeLessThan(200);
  });

  it("orders several fields by cost, so the cheap ones all clear a prefix", () => {
    const inv = fields("mcp__x__y", { body: "b".repeat(900), id: 7, note: "n".repeat(80), name: "Q3" });
    expect(inv.entries.map((f) => f.label)).toEqual(["id", "name", "note", "body"]);
  });

  it("still lists every argument — this reorders, it never drops", () => {
    const inv = fields("mcp__x__y", { big: "z".repeat(3000), a: 1, b: 2 });
    expect(inv.entries.map((f) => f.label).sort()).toEqual(["a", "b", "big"]);
    for (const k of ["big", "a", "b"]) expect(inv.json).toContain('"' + k + '"');
  });
});

// The fields themselves: every rule is TYPE-driven, never tool-driven — a
// per-tool dictionary here would mean every new connector renders badly until
// someone writes code for it, which is the exact failure the fields view
// replaces.
describe("describeInvocation — how a field reads", () => {
  const fields = (args: Record<string, unknown>) => {
    const inv = describeInvocation("mcp__any__tool", args);
    if (!inv || inv.kind !== "fields") throw new Error("expected a fields invocation");
    return inv;
  };

  it("turns key punctuation into words: snake, kebab and camel all read the same", () => {
    const inv = fields({ num_results: 15, timeRange: "week", "content-type": "text" });
    expect(inv.entries.map((f) => f.label).sort()).toEqual(["content type", "num results", "time range"]);
  });

  it("keeps scalars as plain readable text", () => {
    const inv = fields({ limit: 15, dry_run: false });
    expect(inv.entries).toEqual([
      { label: "limit", value: "15", mono: false },
      { label: "dry run", value: "false", mono: false },
    ]);
  });

  it("joins a list of scalars instead of rendering brackets and quotes", () => {
    const [f] = fields({ tags: ["ai", "news", 3] }).entries;
    expect(f).toEqual({ label: "tags", value: "ai, news, 3", mono: false });
  });

  it("keeps a nested structure as compact JSON, marked machine-shaped", () => {
    const [f] = fields({ filter: { status: "open" } }).entries;
    expect(f).toEqual({ label: "filter", value: '{"status":"open"}', mono: true });
  });

  it("shows a dash for null and empty string — absence reads the same either way", () => {
    const inv = fields({ cursor: null, note: "" });
    for (const f of inv.entries) expect(f.value).toBe("—");
  });

  // A stated cut, not a silent one: the flag is what lets the UI SAY the value
  // was shortened, and the full text stays reachable in `json`.
  it("clips a payload-sized value and says so, keeping the whole thing in the JSON", () => {
    const long = "y".repeat(800);
    const inv = fields({ body: long });
    const [f] = inv.entries;
    expect(f.clipped).toBe(true);
    expect(f.value.length).toBeLessThan(long.length);
    expect(long.startsWith(f.value)).toBe(true);
    expect(inv.json).toContain(long);
  });
});
