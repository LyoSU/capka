import { describe, it, expect, vi, afterEach } from "vitest";
import type { Tool } from "ai";
import { planToolSearch, FIND_TOOL_NAME, deferTokenBudget } from "../tool-search";

/** A structural stand-in for an adapted tool — planToolSearch only reads
 *  `.description` and `.inputSchema.jsonSchema`. */
function fakeTool(description: string, schema: object = { type: "object", properties: {} }): Tool {
  return { description, inputSchema: { jsonSchema: schema } } as unknown as Tool;
}

/** A description padded so a handful of MCP tools comfortably cross a small budget. */
const bulky = (s: string) => `${s} ${"lorem ipsum dolor sit amet ".repeat(20)}`;

function callFind(plan: ReturnType<typeof planToolSearch>, query: string, limit?: number) {
  const find = plan.extraTools[FIND_TOOL_NAME] as unknown as {
    execute: (a: { query: string; limit?: number }) => Promise<{ matched: { name: string }[]; message: string }>;
  };
  return find.execute({ query, limit });
}

describe("planToolSearch — gating", () => {
  it("is inert when there are no MCP tools", () => {
    const plan = planToolSearch({
      tools: { bash: fakeTool("run a command"), skill: fakeTool("load a skill") },
      effectiveLimit: 1000,
    });
    expect(plan.defer).toBe(false);
    expect(plan.indexText).toBe("");
    expect(plan.extraTools).toEqual({});
    expect(plan.activeToolNames()).toBeUndefined();
  });

  it("does not defer when the connector block fits under the threshold", () => {
    const plan = planToolSearch({
      tools: { bash: fakeTool("x"), mcp__grok__search: fakeTool("search the web") },
      effectiveLimit: 1_000_000, // budget ~100k tokens — one tiny tool never trips it
    });
    expect(plan.defer).toBe(false);
    expect(plan.activeToolNames()).toBeUndefined();
  });

  it("defers when the connector block exceeds the threshold", () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 8; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    const plan = planToolSearch({ tools, effectiveLimit: 2000 }); // budget 200 tokens
    expect(plan.defer).toBe(true);
    expect(plan.extraTools[FIND_TOOL_NAME]).toBeDefined();
    expect(plan.indexText).toContain("firecrawl");
  });

  it("still defers a heavy connector block on a huge context window", () => {
    // 10% of a 1M-token window is ~100k, so percentage gating alone never fires
    // there and a Firecrawl-scale block rides along in every prompt.
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 80; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    expect(planToolSearch({ tools, effectiveLimit: 1_000_000 }).defer).toBe(true);
  });
});

describe("deferTokenBudget", () => {
  it("clamps the percentage budget with the absolute ceiling", () => {
    expect(deferTokenBudget(1_000_000, 10, 8192)).toBe(8192);
    expect(deferTokenBudget(20_000, 10, 8192)).toBe(2000); // percentage still wins when smaller
  });

  it("treats a zero ceiling as 'no ceiling', and a zero percentage as 'always defer'", () => {
    expect(deferTokenBudget(1_000_000, 10, 0)).toBe(100_000);
    expect(deferTokenBudget(1_000_000, 0, 8192)).toBe(0);
  });
});

describe("defer thresholds from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** The thresholds are read once at module load, so each case needs a fresh import. */
  async function freshPlan(env: Record<string, string>, tools: Record<string, Tool>, effectiveLimit: number) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import("../tool-search");
    return mod.planToolSearch({ tools, effectiveLimit });
  }

  it("honours an explicit MCP_DEFER_TOKEN_PCT=0 as 'always defer'", async () => {
    const tools: Record<string, Tool> = { mcp__grok__search: fakeTool("search the web") };
    // A single tiny tool: it only defers if the budget really is 0. Reading `0` as
    // "unset" (and falling back to 10%) would leave this eager.
    const plan = await freshPlan({ MCP_DEFER_TOKEN_PCT: "0" }, tools, 1_000_000);
    expect(plan.defer).toBe(true);
  });

  it("lets MCP_DEFER_TOKEN_MAX=0 restore percentage-only gating", async () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 80; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    const plan = await freshPlan({ MCP_DEFER_TOKEN_MAX: "0" }, tools, 1_000_000);
    expect(plan.defer).toBe(false);
  });

  /** The budget straight from the module constants, so the ENV read is what is
   *  measured rather than an argument the test supplies itself. */
  async function freshBudget(env: Record<string, string>, effectiveLimit: number) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return (await import("../tool-search")).deferTokenBudget(effectiveLimit);
  }

  it("keeps a fractional MCP_DEFER_TOKEN_PCT fractional", async () => {
    // This knob is a PERCENTAGE, and `finiteNonNeg` accepts a non-integer on purpose.
    // A shared validator that required an integer would hand back 10 and re-gate the
    // connector block at 100_000 instead of 105_000 — a behaviour change wearing a
    // refactor's clothes, since nothing would report it: the boot diagnostic would
    // still call the value valid and honoured. The ceiling is lifted out of the way
    // so the percentage is the only thing this measures.
    await expect(freshBudget({ MCP_DEFER_TOKEN_PCT: "10.5", MCP_DEFER_TOKEN_MAX: "1000000" }, 1_000_000))
      .resolves.toBe(105_000);
  });

  it("falls back on a negative MCP_DEFER_TOKEN_PCT rather than reading it as 'always defer'", async () => {
    // The other half of the same contract: `>= 0` must keep rejecting a negative.
    // If one ever survived, `thresholdPct <= 0` returns a budget of 0 and every
    // connector set defers — the loudest possible misreading of a typo.
    await expect(freshBudget({ MCP_DEFER_TOKEN_PCT: "-5", MCP_DEFER_TOKEN_MAX: "1000000" }, 1_000_000))
      .resolves.toBe(100_000);
  });
});

describe("MCP_ALWAYS_LOAD — connectors exempt from deferral", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Read once at module load, so each case needs a fresh import. */
  async function freshPlan(env: Record<string, string>, tools: Record<string, Tool>, effectiveLimit = 2000) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import("../tool-search");
    return mod.planToolSearch({ tools, effectiveLimit });
  }

  /** A heavy connector to defer, plus a small one the admin wants always available. */
  const mixed = () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 8; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    tools["mcp__search__web_search"] = fakeTool("search the web");
    return tools;
  };

  it("keeps a pinned connector's tools callable while the rest are deferred", async () => {
    const plan = await freshPlan({ MCP_ALWAYS_LOAD: "search" }, mixed());
    expect(plan.defer).toBe(true);
    expect(plan.activeToolNames()).toContain("mcp__search__web_search");
    expect(plan.activeToolNames()).not.toContain("mcp__firecrawl__firecrawl_tool_0");
  });

  it("leaves a pinned connector out of the on-demand index", async () => {
    // The index tells the model what it must call find_tool for. A pinned
    // connector is already in the tool list, so listing it there invites a
    // pointless round-trip.
    const plan = await freshPlan({ MCP_ALWAYS_LOAD: "search" }, mixed());
    expect(plan.indexText).toContain("**firecrawl**");
    expect(plan.indexText).not.toContain("**search**");
  });

  it("does not return pinned tools from find_tool", async () => {
    const plan = await freshPlan({ MCP_ALWAYS_LOAD: "search" }, mixed());
    const res = await callFind(plan, "search the web");
    expect(res.matched.map((m) => m.name)).not.toContain("mcp__search__web_search");
  });

  it("stays inert when every connector is pinned — there is nothing left to hide", async () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 8; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    const plan = await freshPlan({ MCP_ALWAYS_LOAD: "firecrawl" }, tools);
    expect(plan.defer).toBe(false);
    expect(plan.activeToolNames()).toBeUndefined();
  });

  it("does not count pinned tools against the defer budget", async () => {
    // Pinning is the admin saying "this one always rides along", so its size must
    // not be what pushes the remaining connectors behind find_tool.
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 8; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    tools["mcp__small__ping"] = fakeTool("ping");
    const plan = await freshPlan({ MCP_ALWAYS_LOAD: "firecrawl" }, tools);
    expect(plan.defer).toBe(false);
  });

  it("matches the server name case-insensitively and ignores surrounding spaces", async () => {
    const plan = await freshPlan({ MCP_ALWAYS_LOAD: " Search , other " }, mixed());
    expect(plan.activeToolNames()).toContain("mcp__search__web_search");
  });

  it("pins nothing when unset or empty", async () => {
    const cases: Record<string, string>[] = [{}, { MCP_ALWAYS_LOAD: "" }];
    for (const env of cases) {
      const plan = await freshPlan(env, mixed());
      expect(plan.defer).toBe(true);
      expect(plan.activeToolNames()).not.toContain("mcp__search__web_search");
    }
  });
});

describe("planToolSearch — active-tool accounting", () => {
  const build = () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command"), skill: fakeTool("load a skill") };
    for (let i = 0; i < 6; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    return planToolSearch({ tools, effectiveLimit: 2000 });
  };

  it("starts with only the eager core + find_tool active (connector tools hidden)", () => {
    const active = build().activeToolNames();
    expect(active).toContain("bash");
    expect(active).toContain("skill");
    expect(active).toContain(FIND_TOOL_NAME);
    expect(active!.some((n) => n.startsWith("mcp__"))).toBe(false);
  });

  it("expands matched tools append-only across find_tool calls", async () => {
    const plan = build();
    const r1 = await callFind(plan, "tool 1");
    expect(r1.matched.length).toBeGreaterThan(0);
    const afterFirst = plan.activeToolNames()!;
    for (const m of r1.matched) expect(afterFirst).toContain(m.name);

    // A second call keeps the first call's matches active (append-only).
    await callFind(plan, "tool 3");
    const afterSecond = plan.activeToolNames()!;
    for (const m of r1.matched) expect(afterSecond).toContain(m.name);
    expect(afterSecond.length).toBeGreaterThanOrEqual(afterFirst.length);
  });
});

describe("find_tool — BM25", () => {
  it("matches an English query against an English description", async () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    tools["mcp__firecrawl__firecrawl_scrape"] = fakeTool(bulky("Scrape a single webpage and return its content"));
    tools["mcp__firecrawl__firecrawl_crawl"] = fakeTool(bulky("Crawl an entire website following links"));
    const plan = planToolSearch({ tools, effectiveLimit: 2000 });
    const r = await callFind(plan, "scrape a webpage");
    expect(r.matched[0]?.name).toBe("mcp__firecrawl__firecrawl_scrape");
  });

  it("matches an English query against a NON-English description via the tool name", async () => {
    // The corpus is mixed-language: an image server described in Ukrainian. The
    // English query has zero lexical overlap with the description, so the match
    // must come from the tokenized tool NAME (generate_image → generate, image).
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    tools["mcp__yunwu__generate_image"] = fakeTool(bulky("Згенерувати зображення за текстовим описом користувача"));
    tools["mcp__yunwu__edit_photo"] = fakeTool(bulky("Відредагувати наявну світлину за інструкцією"));
    const plan = planToolSearch({ tools, effectiveLimit: 2000 });
    const r = await callFind(plan, "generate an image");
    expect(r.matched.map((m) => m.name)).toContain("mcp__yunwu__generate_image");
  });

  it("returns the connector index and expands nothing when nothing matches", async () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (let i = 0; i < 6; i++) tools[`mcp__firecrawl__firecrawl_tool_${i}`] = fakeTool(bulky(`tool ${i}`));
    const plan = planToolSearch({ tools, effectiveLimit: 2000 });
    const before = plan.activeToolNames()!.length;
    const r = await callFind(plan, "quantum chromodynamics zzzzz");
    expect(r.matched).toEqual([]);
    expect(r.message).toContain("firecrawl");
    expect(plan.activeToolNames()!.length).toBe(before); // no expansion on a miss
  });
});

describe("connector index — capability summary", () => {
  it("describes what a connector CAN DO (from descriptions), deduped by family, not tool names", () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    const defs: [string, string][] = [
      ["firecrawl_scrape", "Scrape a webpage"],
      ["firecrawl_search", "Search the web"],
      ["firecrawl_monitor_create", "Monitor a URL for changes"],
      ["firecrawl_monitor_list", "List existing change monitors"],
      ["firecrawl_research_search_papers", "Search academic papers"],
      ["firecrawl_research_read_paper", "Read a paper's full text"],
    ];
    // Pad so the block crosses the defer threshold; the gist takes the first clause.
    for (const [t, d] of defs) tools[`mcp__firecrawl__${t}`] = fakeTool(`${d}. ${"lorem ipsum ".repeat(20)}`);
    const plan = planToolSearch({ tools, effectiveLimit: 2000 });
    expect(plan.defer).toBe(true);

    // Capability gists — the model sees WHAT the connector does, incl. the
    // monitor and research domains that a truncated name list would have hidden.
    expect(plan.indexText).toContain("Monitor a URL for changes");
    expect(plan.indexText).toContain("Scrape a webpage");
    expect(plan.indexText).toContain("paper"); // the research domain is represented
    // Not a list of tool names.
    expect(plan.indexText).not.toContain("firecrawl_monitor_create");
    // Deduped by family: the domain shows ONCE (one representative per family), so
    // the seven-tool monitor family doesn't spam the line.
    expect((plan.indexText.match(/Monitor a URL for changes/g) ?? []).length).toBe(1);
    expect(plan.indexText).not.toContain("List existing change monitors");
  });

  it("falls back to the de-prefixed tool name when a connector ships no descriptions", () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    // No descriptions → gist must degrade to the readable name, still crossing the
    // threshold via schema bulk.
    const schema = { type: "object", properties: Object.fromEntries([...Array(30)].map((_, i) => [`p${i}`, { type: "string", description: "x".repeat(30) }])) };
    for (const t of ["acme_send_message", "acme_list_channels"]) {
      tools[`mcp__acme__${t}`] = { description: "", inputSchema: { jsonSchema: schema } } as unknown as Tool;
    }
    const plan = planToolSearch({ tools, effectiveLimit: 1500 });
    expect(plan.defer).toBe(true);
    expect(plan.indexText).toContain("send message");
    expect(plan.indexText).toContain("list channels");
  });
});
