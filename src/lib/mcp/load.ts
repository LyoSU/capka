import { createHash } from "node:crypto";
import type { Tool } from "ai";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { withChildSpan } from "@/lib/telemetry";
import { connectMcpServer, disconnectMcp, type ConnectedMcp } from "./client";
import { adaptMcpTool, mcpToolName } from "./adapt";
import { listEnabledServerConfigs } from "./service";
import { recordConnectError, clearConnectError, recentlyFailed } from "./connect-errors";
import { getCachedTools, setCachedTools, cachedToolsAreStale } from "./tool-cache";
import { hasUserTokens } from "./oauth/store";
import { McpOAuthProvider } from "./oauth/provider";
import { needsPluginRoot, resolvePluginRoot } from "./plugin-runtime";
import type { McpServerConfig } from "./types";

/** Don't re-dial a connector that failed recently — one broken server shouldn't
 *  re-spend its connect cost every turn. Gates the background schema warms; a lazy
 *  connect triggered by an actual tool call is never blocked (the model chose to
 *  use it). 10 min matches the connect-error TTL the UI shows, so a persistently
 *  broken connector is retried rarely, not every minute. A config edit or a
 *  successful connect clears it immediately. */
const CONNECT_BACKOFF_MS = 10 * 60_000;

const cacheKey = (c: McpServerConfig) => c.id ?? c.name;

/**
 * Build the agent's MCP tool set for a run — WITHOUT putting a slow connector on
 * the critical path of time-to-first-token.
 *
 * EVERY connector — remote and stdio alike — is served from an in-process
 * tool-schema cache and connected LAZILY, only when the model actually calls one
 * of its tools. A cold cache (just-enabled connector, or the first turn after a
 * restart) is warmed in the background, so the connector's tools appear from the
 * next turn; the current turn is never blocked.
 *
 * - **stdio** is the expensive case: the server runs inside the chat's sandbox via
 *   `docker exec` and `npx`/`uvx` self-installs its package on first run — tens of
 *   seconds in a fresh per-chat container (up to the connect timeout when the
 *   sandbox has no egress).
 * - **remote** used to be dialled eagerly, on the assumption that a handshake is
 *   sub-second. It isn't: `initialize` + `notifications/initialized` + `tools/list`
 *   plus TLS measures ~0.9-1.7s against a small public MCP server, and that was
 *   paid on every turn — even when the model called nothing, and even when
 *   progressive disclosure then hid those very tools behind `find_tool`.
 *
 * A remote warm dials, reads the schemas and HANGS UP: it needs no sandbox (so it
 * can never resurrect a container after the turn that owned it ended) and holds no
 * session across the LLM stream. It deliberately bypasses the connection memo
 * below — a hung-up client must never be handed to a later tool call.
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
  /** Governance "ask": every tool of this server suspends for the user's
   *  approval before executing (SDK needsApproval). Absent = no gating. */
  serverNeedsApproval?: (name: string) => boolean;
  /** The run's citation counter — search-shaped results number their records
   *  through it so `[N]` stays unique across the turn. Absent (cache warms)
   *  disables search normalization. */
  sourceCounter?: { next: number };
  /** Present during a live turn: lets a connector elicit input from the user
   *  mid-tool-call (block-and-poll). Omitted for background cache warms. */
  elicitContext?: import("./client").ElicitContext;
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
  const spillCtx = { sessionKey: opts.sessionKey, userId: opts.userId, sources: opts.sourceCounter };
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
      // The handshake costs ~0.9–1.7s for a remote server and is invisible in the
      // SDK's ai.toolCall timing — the first tool call on a cold connection just
      // looks slow. Server NAMES are user-supplied, so only the transport and a
      // stable hash of the key are recorded.
      p = withChildSpan("capka.mcp.connect", {
        "capka.mcp.transport": c.transport ?? "unknown",
        "capka.mcp.server_hash": createHash("sha256").update(k).digest("hex").slice(0, 12),
      }, async () => {
        // stdio: its server is `docker exec`'d into the sandbox (and a plugin's
        // files are materialized via exec), so the container must exist first.
        if (c.transport === "stdio" && opts.ensureSession) await opts.ensureSession();
        const authProvider = c.authKind === "oauth" && c.id
          ? new McpOAuthProvider(opts.userId, c.id, "runtime")
          : undefined;
        const cfg = opts.sessionKey && needsPluginRoot(c)
          ? await resolvePluginRoot(opts.sessionKey, c)
          : c;
        const conn = await connectMcpServer(cfg, { blockPrivate, authProvider, sessionKey: opts.sessionKey, elicitContext: opts.elicitContext });
        connected.push(conn);
        setCachedTools(k, conn.tools); // refresh the schema cache for next turn
        clearConnectError(opts.userId, c.id);
        return conn;
      }).catch((e) => {
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

  /** Read a remote server's schemas and hang up. No sandbox, no elicitation (a
   *  background warm must never surface a question), no entry in the memo. */
  const warmRemoteSchema = async (c: McpServerConfig): Promise<void> => {
    try {
      const authProvider = c.authKind === "oauth" && c.id
        ? new McpOAuthProvider(opts.userId, c.id, "runtime")
        : undefined;
      const conn = await connectMcpServer(c, { blockPrivate, authProvider });
      setCachedTools(cacheKey(c), conn.tools);
      clearConnectError(opts.userId, c.id);
      await disconnectMcp(conn).catch(() => {});
    } catch (e) {
      recordConnectError(opts.userId, c.id, e instanceof Error ? e.message : String(e));
    }
  };

  // Warms whose connection is HELD for the run (stdio only) — close() must wait for
  // those, or a connection resolving after teardown would leak. Remote warms hang up
  // on their own, so making close() wait on them would just park the worker between
  // turns on a slow server.
  const heldWarmups: Promise<unknown>[] = [];

  for (const c of configs) {
    // An OAuth connector with no stored token can only 401 — that's "not signed in
    // yet", not a failure. Skip it (no connect, no recorded error, so no backoff to
    // later hide it) until the user signs in; its tools then appear next turn.
    // clearConnectError on a successful connect covers the revoked-then-reauthorized
    // case, where a token exists but the server rejected it.
    if (c.authKind === "oauth" && c.id && !(await hasUserTokens(opts.userId, c.id))) continue;

    const cached = getCachedTools(cacheKey(c));
    if (cached) {
      const caller = lazyCaller(c);
      const gated = opts.serverNeedsApproval?.(c.name) ?? false;
      for (const mt of [...cached].sort((a, b) => a.name.localeCompare(b.name))) {
        tools[mcpToolName(c.name, mt.name)] = adaptMcpTool(caller, c.name, mt, spillCtx, gated);
      }
      // Stale-while-revalidate, remote only: a server can gain or lose tools without
      // telling us, and if the model never calls one nothing else re-reads its
      // schemas. The refresh is a background dial-and-hang-up, so this turn keeps
      // the tools it already knows about and the next turn gets the true set.
      // Deliberately NOT done for stdio: refreshing there means spinning the
      // sandbox and an `npx` install — far too expensive to do on a timer. A stdio
      // connector refreshes when the model actually calls one of its tools.
      if (c.transport !== "stdio" && cachedToolsAreStale(cacheKey(c))) {
        warmups.push(warmRemoteSchema(c));
      }
      continue;
    }
    if (c.id && recentlyFailed(opts.userId, c.id, CONNECT_BACKOFF_MS)) continue;
    if (c.transport === "stdio") {
      // Needs the sandbox either way, and the connection is worth keeping once paid
      // for; failures are already recorded by connect().
      heldWarmups.push(connect(c).catch(() => {}));
    } else {
      warmups.push(warmRemoteSchema(c));
    }
  }

  const heldWarming = Promise.allSettled(heldWarmups);
  // Exposed so tests can observe both kinds of warm deterministically.
  const warming = Promise.allSettled([...warmups, heldWarming]);
  return {
    tools,
    warming,
    close: async () => {
      await heldWarming;
      await Promise.allSettled(connected.map(disconnectMcp));
    },
  };
}
