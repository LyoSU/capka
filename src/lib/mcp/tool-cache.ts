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

/** How long an entry is trusted before a caller should revalidate it. A server can
 *  gain or lose tools without telling us, and nothing else re-reads its schemas
 *  unless the model happens to call one — so an entry that is never touched would
 *  otherwise describe the connector as it was at the last successful connect,
 *  forever. Stale is a hint to REFRESH, not to stop serving (see below). */
export const SCHEMA_TTL_MS = 30 * 60_000;

const g = globalThis as unknown as { __mcpToolCache?: Map<string, { tools: CachedTool[]; at: number }> };
const cache = (g.__mcpToolCache ??= new Map<string, { tools: CachedTool[]; at: number }>());

/** The cached schemas, however old. Deliberately still served when stale: dropping
 *  an entry at the TTL would cost a whole turn without that connector's tools, at
 *  an arbitrary point in someone's conversation. Callers pair this with
 *  {@link cachedToolsAreStale} to refresh behind the turn instead. */
export function getCachedTools(serverId: string): CachedTool[] | undefined {
  return cache.get(serverId)?.tools;
}

/** True when a cached entry exists and is past {@link SCHEMA_TTL_MS}. False for an
 *  unknown server — there is nothing to revalidate, that is a cold cache. */
export function cachedToolsAreStale(serverId: string): boolean {
  const hit = cache.get(serverId);
  return !!hit && Date.now() - hit.at >= SCHEMA_TTL_MS;
}

export function setCachedTools(serverId: string, tools: CachedTool[]): void {
  cache.set(serverId, { tools, at: Date.now() });
}

/** Drop a server's schemas. Called when the connector's config changes or it is
 *  deleted: the entry describes a server we may no longer be talking to, and it
 *  would otherwise be handed to the model until something happened to reconnect.
 *  Also what keeps the map bounded — it holds one entry per EXISTING connector,
 *  not one per connector ever created. */
export function clearCachedTools(serverId: string): void {
  cache.delete(serverId);
}
