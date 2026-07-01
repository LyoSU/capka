import type { Tool } from "ai";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { connectMcpServer, disconnectMcp, type ConnectedMcp } from "./client";
import { adaptMcpTool, mcpToolName } from "./adapt";
import { listEnabledServerConfigs } from "./service";
import { recordConnectError, clearConnectError, recentlyFailed } from "./connect-errors";
import { getCachedTools, setCachedTools } from "./tool-cache";
import { McpOAuthProvider } from "./oauth/provider";
import { needsPluginRoot, resolvePluginRoot } from "./plugin-runtime";
import type { McpServerConfig } from "./types";

const MAX_CONCURRENT = 4;
/** Don't re-dial a connector that failed recently — one broken server shouldn't
 *  re-spend its connect cost every turn. Gates the eager http connect and the
 *  background stdio warm; a lazy connect triggered by an actual tool call is never
 *  blocked (the model chose to use it). 10 min matches the connect-error TTL the
 *  UI shows, so a persistently broken connector is retried rarely, not every
 *  minute. A config edit or a successful connect clears it immediately. */
const CONNECT_BACKOFF_MS = 10 * 60_000;

const cacheKey = (c: McpServerConfig) => c.id ?? c.name;

/**
 * Build the agent's MCP tool set for a run — WITHOUT putting a slow connector on
 * the critical path of time-to-first-token.
 *
 * - **http** connectors connect eagerly (a remote handshake is sub-second) and
 *   expose their tools immediately, as before.
 * - **stdio** connectors are served from an in-process tool-schema cache and
 *   connected LAZILY, only when the model actually calls one of their tools. A
 *   stdio server runs inside the chat's sandbox via `docker exec` and `npx`/`uvx`
 *   self-installs its package on first run — tens of seconds in a fresh per-chat
 *   container (up to the connect timeout when the sandbox has no egress). Doing
 *   that here, eagerly, delayed EVERY turn's first token even when the model never
 *   touched the connector. A cold cache (just-enabled connector, or first turn
 *   after a restart) is warmed in the background, so the connector's tools simply
 *   appear from the next turn — the current turn is never blocked.
 *
 * Tools are collected in deterministic order (servers by name, tools by name) so
 * the position-0 tool prefix stays cache-stable for prompt caching. A server that
 * fails to connect is logged + skipped — never fatal — and its error is recorded
 * for the connectors UI to surface (G1 governance still applies via isServerAllowed).
 */
export async function loadMcpTools(opts: {
  userId: string;
  projectId: string | null;
  /** The run's sandbox session — required to bridge stdio connectors. */
  sessionKey?: string;
  /** Shared, memoized session creator. A stdio connector runs via `docker exec`
   *  inside the sandbox, so the container must exist before we connect — the lazy
   *  connect calls this first. http/sse connectors don't need it. */
  ensureSession?: () => Promise<unknown>;
  /** Governance gate — a denied connector is never connected (G1). */
  isServerAllowed?: (name: string) => boolean;
}): Promise<{
  tools: Record<string, Tool>;
  close: () => Promise<void>;
  /** Resolves when background cache-warms finish. The runner ignores it; tests
   *  await it to observe the warm deterministically. */
  warming: Promise<unknown>;
}> {
  const allow = opts.isServerAllowed ?? (() => true);
  // Passed to every adapted tool so an oversized result can be parked in the
  // workspace (off-disk via the controller file API — no container needed).
  const spillCtx = { sessionKey: opts.sessionKey, userId: opts.userId };
  const configs = (await listEnabledServerConfigs(opts.userId, opts.projectId))
    .filter((c) => allow(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const blockPrivate = await getBlockPrivateProviderUrls();
  const connected: ConnectedMcp[] = [];
  const tools: Record<string, Tool> = {};
  const warmups: Promise<unknown>[] = [];

  // One connection per server, memoized, so a server's tools share a single
  // (slow, for stdio) connection and the background warm + a lazy tool call never
  // dial twice. The connection is held for the whole run and torn down in close().
  const connections = new Map<string, Promise<ConnectedMcp>>();
  const connect = (c: McpServerConfig): Promise<ConnectedMcp> => {
    const k = cacheKey(c);
    let p = connections.get(k);
    if (!p) {
      p = (async () => {
        // stdio: its server is `docker exec`'d into the sandbox (and a plugin's
        // files are materialized via exec), so the container must exist first.
        if (c.transport === "stdio" && opts.ensureSession) await opts.ensureSession();
        const authProvider = c.authKind === "oauth" && c.id
          ? new McpOAuthProvider(opts.userId, c.id, "runtime")
          : undefined;
        const cfg = opts.sessionKey && needsPluginRoot(c)
          ? await resolvePluginRoot(opts.sessionKey, c)
          : c;
        const conn = await connectMcpServer(cfg, { blockPrivate, authProvider, sessionKey: opts.sessionKey });
        connected.push(conn);
        setCachedTools(k, conn.tools); // refresh the schema cache for next turn
        clearConnectError(opts.userId, c.id);
        return conn;
      })().catch((e) => {
        // Let a later consumer in the same run retry, and surface WHY in the UI.
        connections.delete(k);
        recordConnectError(opts.userId, c.id, e instanceof Error ? e.message : String(e));
        throw e;
      });
      connections.set(k, p);
    }
    return p;
  };

  // A lazy MCP client: it connects on the first tool call, then delegates. Shared
  // across all of a server's tools via the memoized `connect`.
  const lazyCaller = (c: McpServerConfig) => ({
    callTool: async (
      params: { name: string; arguments: Record<string, unknown> },
      resultSchema?: undefined,
      options?: { signal?: AbortSignal },
    ) => (await connect(c)).client.callTool(params, resultSchema, options),
  });

  const httpConfigs = configs.filter((c) => c.transport !== "stdio");
  const stdioConfigs = configs.filter((c) => c.transport === "stdio");

  // http: eager connect (bounded concurrency), tools exposed now.
  for (let i = 0; i < httpConfigs.length; i += MAX_CONCURRENT) {
    const batch = httpConfigs
      .slice(i, i + MAX_CONCURRENT)
      .filter((c) => !(c.id && recentlyFailed(opts.userId, c.id, CONNECT_BACKOFF_MS)));
    await Promise.allSettled(batch.map(async (c) => {
      const conn = await connect(c);
      for (const mt of [...conn.tools].sort((a, b) => a.name.localeCompare(b.name))) {
        tools[mcpToolName(c.name, mt.name)] = adaptMcpTool(conn.client, c.name, mt, spillCtx);
      }
    }));
  }

  // stdio: serve from the schema cache + connect lazily; warm a cold cache in the
  // background so the connector's tools appear next turn (never blocks this one).
  for (const c of stdioConfigs) {
    const cached = getCachedTools(cacheKey(c));
    if (cached) {
      const caller = lazyCaller(c);
      for (const mt of [...cached].sort((a, b) => a.name.localeCompare(b.name))) {
        tools[mcpToolName(c.name, mt.name)] = adaptMcpTool(caller, c.name, mt, spillCtx);
      }
    } else if (!(c.id && recentlyFailed(opts.userId, c.id, CONNECT_BACKOFF_MS))) {
      warmups.push(connect(c).catch(() => {})); // failures already recorded above
    }
  }

  const warming = Promise.allSettled(warmups);
  return {
    tools,
    warming,
    close: async () => {
      // Wait for any in-flight warm so its connection is tracked before we tear
      // down — otherwise a connection that resolves after close() would leak.
      await warming;
      await Promise.allSettled(connected.map(disconnectMcp));
    },
  };
}
