/**
 * In-process cache of each MCP server's tool SCHEMAS, keyed by server id.
 *
 * A server's tool list is a property of the server, not of the user or the run,
 * so it's the same for everyone and stable between turns. Caching it lets
 * `loadMcpTools` declare a connector's tools to the model WITHOUT connecting —
 * which, for a stdio connector, means without spinning the sandbox and waiting on
 * an `npx`/`uvx` self-install on the critical path of every turn. The real
 * connection is then established lazily, only when the model actually calls one of
 * the tools. The cache is repopulated by a background warm (see load.ts), so a
 * cold start (a just-enabled connector, or the first turn after a restart) costs
 * one turn's absence of that connector's tools, never a blocked turn.
 *
 * Intentionally NOT persisted: a restart simply re-warms it in the background.
 */
export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const cache = new Map<string, CachedTool[]>();

export function getCachedTools(serverId: string): CachedTool[] | undefined {
  return cache.get(serverId);
}

export function setCachedTools(serverId: string, tools: CachedTool[]): void {
  cache.set(serverId, tools);
}

export function clearCachedTools(serverId: string): void {
  cache.delete(serverId);
}
