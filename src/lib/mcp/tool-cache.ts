/**
 * In-process cache of each MCP server's tool SCHEMAS, keyed by server id.
 *
 * A server's tool list is a property of the server, not of the user or the run,
 * so it's the same for everyone and stable between turns. Caching it lets
 * `loadMcpTools` declare a connector's tools to the model WITHOUT connecting —
 * no sandbox spin-up and `npx`/`uvx` self-install for a stdio server, no remote
 * handshake for an http/sse one, on the critical path of every turn. The real
 * connection is then established lazily, only when the model actually calls one of
 * the tools. The cache is repopulated by a background warm (see load.ts), so a
 * cold start (a just-enabled connector, or the first turn after a restart) costs
 * one turn's absence of that connector's tools, never a blocked turn.
 *
 * Held on `globalThis`, like the worker / realtime / aux-usage singletons: Next.js
 * can evaluate a module more than once in one process, and a module-level Map then
 * gives the second copy an empty cache — every turn would miss and re-dial every
 * connector, which is the cost this cache exists to remove.
 *
 * Intentionally NOT persisted to disk: schemas are cheap to re-warm, and a shared
 * file would be one mutable blob covering every user's connectors.
 */
export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const g = globalThis as unknown as { __mcpToolCache?: Map<string, CachedTool[]> };
const cache = (g.__mcpToolCache ??= new Map<string, CachedTool[]>());

export function getCachedTools(serverId: string): CachedTool[] | undefined {
  return cache.get(serverId);
}

export function setCachedTools(serverId: string, tools: CachedTool[]): void {
  cache.set(serverId, tools);
}

export function clearCachedTools(serverId: string): void {
  cache.delete(serverId);
}
