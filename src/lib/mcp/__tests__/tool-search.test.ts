import { describe, it, expect } from "vitest";
import type { Tool } from "ai";
import { planToolSearch, FIND_TOOL_NAME } from "../tool-search";

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

describe("connector index — diversity sampling", () => {
  it("surfaces distinct tool families of a large server, not just the alphabetical head", () => {
    const tools: Record<string, Tool> = { bash: fakeTool("run a command") };
    for (const t of [
      "firecrawl_scrape",
      "firecrawl_search",
      "firecrawl_crawl",
      "firecrawl_monitor_create",
      "firecrawl_monitor_list",
      "firecrawl_research_read_paper",
      "firecrawl_research_search_papers",
    ]) {
      tools[`mcp__firecrawl__${t}`] = fakeTool(bulky(t));
    }
    const plan = planToolSearch({ tools, effectiveLimit: 2000 });
    expect(plan.defer).toBe(true);
    // The monitor_* and research_* families must appear despite sorting after
    // scrape/search/crawl — otherwise the model never learns to ask for them.
    expect(plan.indexText).toContain("monitor");
    expect(plan.indexText).toContain("research");
  });
});
