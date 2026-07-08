import { tool, type Tool } from "ai";
import { z } from "zod";
import { log } from "@/lib/log";

/**
 * Provider-agnostic progressive tool disclosure ("tool search").
 *
 * The problem: a single MCP connector can bring dozens of tools (Firecrawl ~28),
 * and every enabled connector's full schema is serialized into EVERY request —
 * the "menu tax" (see adapt.ts). It taxes context and, past a point, degrades the
 * model's tool choice. Anthropic ships a native `defer_loading` + tool-search
 * beta for this, but it rides the Messages API and would only help the Anthropic
 * path. Capka runs its own AI SDK loop across many providers, so we implement the
 * SAME pattern client-side, purely with ordinary function calling + the SDK's
 * `activeTools` lever — which works on any tool-capable model.
 *
 * How it works:
 *  - The model always sees the small "eager" core (sandbox, manage, ask, memory,
 *    skill, provider-native) plus this one `find_tool`. Connector tools are
 *    registered but kept OUT of `activeTools`, so their schemas never enter the
 *    request until needed.
 *  - A one-line-per-connector index in the system prompt tells the model what
 *    exists (so it can phrase a `find_tool` query), without paying per-tool cost.
 *  - `find_tool(query)` runs BM25 over the deferred tools' names+descriptions and
 *    marks the matches as expanded; `prepareStep` then adds them to `activeTools`
 *    for subsequent steps, so their full schemas arrive on demand.
 *
 * Cache: the tools block is serialized BEFORE system + messages, so changing
 * `activeTools` mid-turn invalidates the prompt cache for everything after it —
 * append-only does NOT preserve the conversation prefix. Its real value is
 * DETERMINISM: once the model has expanded what it needs, every later step of the
 * turn sees an identical tool set, so the rebuild happens exactly once (like the
 * one-off cost `stepSettings` already accepts for a late `toolChoice`), not once
 * per step.
 *
 * Gating: deferral only kicks in when the connector tools' estimated cost exceeds
 * a fraction of the effective context window (`MCP_DEFER_TOKEN_PCT`, default 10%),
 * mirroring Anthropic's `auto:N`. A small chat with a couple of tools behaves
 * exactly as before — no index, no extra round-trip.
 */

export const FIND_TOOL_NAME = "find_tool";

/** Percentage of the effective context window the connector tool block may occupy
 *  before deferral kicks in. Matches Anthropic's `auto:N` default of ~10%. */
const DEFER_PCT = Number(process.env.MCP_DEFER_TOKEN_PCT) || 10;

/** How many tools a single `find_tool` call may surface by default. Generous on
 *  purpose: BM25 is lexical, so a synonym gap ("fetch page" vs "scrape") is real —
 *  recall matters more than precision here since the cost of a miss is a wasted
 *  round-trip, while a couple of extra loaded tools is cheap. */
const DEFAULT_FIND_LIMIT = 8;

/** The minimal shape planToolSearch reads from an assembled tool. Accepting this
 *  structural type (not the AI SDK `Tool`) lets the caller pass its precisely-typed
 *  tool map without a cast — `Tool` is invariant on its input-schema generic, so a
 *  concrete `{ bash: Tool<…>, … }` is not assignable to `Record<string, Tool>`. */
type ReadableTool = { description?: string; inputSchema?: unknown };

/** An MCP tool is any registered tool keyed `mcp__server__tool` (see mcpToolName).
 *  Everything else (sandbox/manage/ask/memory/skill/native) is eager core. */
const isMcpToolName = (name: string) => name.startsWith("mcp__");

/** `mcp__firecrawl__firecrawl_search` → { server: "firecrawl", short: "firecrawl_search" }. */
function splitMcpName(name: string): { server: string; short: string } {
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  return i === -1
    ? { server: rest, short: rest }
    : { server: rest.slice(0, i), short: rest.slice(i + 2) };
}

/** A diverse sample of a server's tool names for the prompt index: one per
 *  distinct capability family (the token after any server-name echo) so breadth
 *  wins over an alphabetical prefix. `shorts` is pre-sorted; caps at 12 families. */
function sampleNames(shorts: string[], server: string, cap = 12): string {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const s of shorts) {
    const toks = s.split(/[_-]/).filter(Boolean);
    const key = toks[0] === server ? toks[1] ?? toks[0] : toks[0];
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(s);
    if (picked.length >= cap) break;
  }
  const more = shorts.length > picked.length ? `, … (${shorts.length} total)` : "";
  return `${picked.join(", ")}${more}`;
}

/** Rough token estimate for a tool's serialized definition (name + description +
 *  input schema), chars/4. Precision is irrelevant here — this only decides
 *  whether the block is big enough to bother deferring. */
function estimateToolTokens(t: ReadableTool): number {
  let chars = 40 + (t.description?.length ?? 0); // name + JSON wrapper + description
  try {
    // dynamicTool wraps the raw schema under `.jsonSchema`; fall back to the value
    // itself. JSON.stringify(undefined) returns undefined → caught, description-only.
    const schema = t.inputSchema as { jsonSchema?: unknown } | undefined;
    chars += JSON.stringify(schema?.jsonSchema ?? schema).length;
  } catch {
    /* description-only estimate */
  }
  return Math.ceil(chars / 4);
}

// ── BM25 ────────────────────────────────────────────────────────────────────
// Compact BM25 over the deferred tools. Zero deps, synchronous, provider-agnostic
// — the same regex/keyword default Anthropic's tool-search ships. Search quality
// rides on tool descriptions (already length-clamped in adapt.ts), which is why a
// good description matters more once tools are discovered rather than always-on.

const K1 = 1.5;
const B = 0.75;

/** Lowercase, split on non-alphanumerics, and also break snake_case/camelCase so
 *  `firecrawl_search` and `getUserOrders` yield useful terms. Drops 1-char noise. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

interface Doc {
  name: string;
  description: string;
  terms: string[];
}

function bm25Search(docs: Doc[], query: string, limit: number): Doc[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];

  const avgLen = docs.reduce((s, d) => s + d.terms.length, 0) / (docs.length || 1);
  // Document frequency per query term.
  const df = new Map<string, number>();
  for (const term of new Set(qTerms)) {
    df.set(term, docs.filter((d) => d.terms.includes(term)).length);
  }

  const scored = docs.map((d) => {
    let score = 0;
    for (const term of qTerms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const tf = d.terms.filter((t) => t === term).length;
      const denom = tf + K1 * (1 - B + (B * d.terms.length) / (avgLen || 1));
      score += idf * ((tf * (K1 + 1)) / (denom || 1));
    }
    return { doc: d, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.doc);
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface ToolSearchPlan {
  /** Whether deferral is active this turn. When false, every field below is inert
   *  and the caller behaves exactly as before (all tools active, no index). */
  defer: boolean;
  /** Index block for the system prompt (one line per connector). "" when !defer. */
  indexText: string;
  /** The `find_tool` to merge into the tool set. Empty record when !defer. */
  extraTools: Record<string, Tool>;
  /** `activeTools` for streamText / prepareStep. `undefined` when !defer, meaning
   *  "all tools active" (the SDK default). When deferring, returns the eager core
   *  + find_tool + whatever the model has expanded so far (append-only). */
  activeToolNames(): string[] | undefined;
}

const INERT_PLAN: ToolSearchPlan = {
  defer: false,
  indexText: "",
  extraTools: {},
  activeToolNames: () => undefined,
};

/**
 * Decide whether to defer connector tools this turn and, if so, build the
 * `find_tool`, the system-prompt index, and the active-tool accounting.
 *
 * `tools` is the fully assembled set (eager core + MCP). `effectiveLimit` is the
 * turn's context window after the admin cap (runner already computes it).
 */
export function planToolSearch(opts: {
  // Values may be `undefined` in the caller's union type (provider-native tools
  // exist only for some providers); MCP keys are always present at runtime.
  tools: Record<string, ReadableTool | undefined>;
  effectiveLimit: number;
  thresholdPct?: number;
}): ToolSearchPlan {
  const mcpNames = Object.keys(opts.tools).filter(isMcpToolName);
  if (mcpNames.length === 0) return INERT_PLAN;

  const mcpTokens = mcpNames.reduce((s, n) => s + estimateToolTokens(opts.tools[n]!), 0);
  const budget = (opts.effectiveLimit * (opts.thresholdPct ?? DEFER_PCT)) / 100;
  if (mcpTokens <= budget) return INERT_PLAN;

  // Decision is made ONCE, at the start of the turn, off the connector set as it
  // stands now — it never flips mid-turn. Logged so a chat that silently crosses
  // the threshold (e.g. the user just added a connector via `manage`) is visible.
  log.info("mcp.defer", { tools: mcpNames.length, estTokens: mcpTokens, budget: Math.round(budget) });

  const eagerNames = Object.keys(opts.tools).filter((n) => !isMcpToolName(n));
  const sortedMcp = [...mcpNames].sort();

  // Deterministic catalog (sorted) so BM25 and the index are stable turn to turn.
  // BM25 indexes the tool's SHORT NAME as well as its description: names are always
  // English and snake_case-tokenized (generate_image → generate, image), so an
  // English query still matches a connector whose description is in another
  // language (e.g. a Ukrainian-described image server) — the cross-lingual floor.
  const docs: Doc[] = sortedMcp.map((name) => {
    const { short } = splitMcpName(name);
    const description = opts.tools[name]?.description ?? "";
    return { name, description, terms: tokenize(`${short} ${description}`) };
  });

  // ── System-prompt index: one line per connector with a DIVERSE sample of tool
  //    names so the model has the vocabulary to phrase a find_tool query. A big
  //    server (Firecrawl: scrape + crawl + monitor_* + research_* …) needs the
  //    breadth of its sub-families surfaced, not the first-N alphabetically —
  //    otherwise the model never thinks to ask for a whole capability. ──────────
  const byServer = new Map<string, string[]>();
  for (const name of sortedMcp) {
    const { server, short } = splitMcpName(name);
    const list = byServer.get(server);
    if (list) list.push(short);
    else byServer.set(server, [short]);
  }
  const serverLines = [...byServer.entries()].map(
    ([server, shorts]) => `- **${server}** (${shorts.length} tool${shorts.length === 1 ? "" : "s"}): ${sampleNames(shorts, server)}`,
  );
  const indexText = [
    "## Connector tools (loaded on demand)",
    `Extra tools from connected apps are available but not loaded up front, to keep your context lean. To use any of them, first call \`${FIND_TOOL_NAME}\` with a short description of what you need — the matching tools then become callable on your next step. Do NOT guess a connector tool name directly; discover it with \`${FIND_TOOL_NAME}\` first.`,
    "Available connectors:",
    ...serverLines,
  ].join("\n");

  // ── find_tool: BM25 over the deferred catalog; matches become active next step.
  const expanded = new Set<string>();
  const findTool = tool({
    description:
      "Discover connector tools that are not yet loaded. Pass a short natural-language description of the capability you need " +
      "(e.g. \"search the web\", \"read a PDF from a URL\"). Returns the best-matching tools; they become callable on your next step. " +
      "Call this before using any connector listed under \"Connector tools\" in the system prompt.",
    inputSchema: z.object({
      query: z.string().describe("What you want to do, in a few words"),
      limit: z.number().int().min(1).max(15).optional().describe("Max tools to return (default 5)"),
    }),
    execute: async ({ query, limit }) => {
      const hits = bm25Search(docs, query, limit ?? DEFAULT_FIND_LIMIT);
      // Telemetry: query → matches. The only lever for tuning BM25, the sample
      // breadth, and the defer threshold — without it none of these is observable.
      log.info("mcp.find_tool", { query, matched: hits.map((h) => h.name) });
      if (hits.length === 0) {
        return {
          matched: [],
          message: `No connector tools matched "${query}". Available connectors:\n${serverLines.join("\n")}`,
        };
      }
      for (const h of hits) expanded.add(h.name);
      return {
        matched: hits.map((h) => ({ name: h.name, description: h.description })),
        message: "These tools are now callable. Call the one you need on your next step.",
      };
    },
  });

  return {
    defer: true,
    indexText,
    extraTools: { [FIND_TOOL_NAME]: findTool },
    activeToolNames: () => [...eagerNames, FIND_TOOL_NAME, ...expanded],
  };
}
