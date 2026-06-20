import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { assertSafeUrl, createGuardedFetch } from "@/lib/net/ssrf";
import type { McpServerConfig } from "./types";

export interface ConnectedMcp {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
}

/** Default ceiling for connecting to a single server. `loadMcpTools` runs before
 *  the stream starts, so a hung connect would otherwise delay every task start. */
const CONNECT_TIMEOUT_MS = 5000;

/** Per-request ceiling for the live transport once connected. The transport reuses
 *  one fetch for the whole session, so this also bounds every tool call — and a real
 *  tool (web/X search, a long job) legitimately runs for many seconds. Capping it at
 *  CONNECT_TIMEOUT_MS aborted slow calls with "operation was aborted due to timeout";
 *  the handshake stall is already bounded by withTimeout below. This stays only as an
 *  SSRF-safe backstop, well above the SDK's own 60s request timeout. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Reject if `p` doesn't settle within `ms`. The label names what timed out so a
 *  skipped connector is identifiable in the logs. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Connect to a remote MCP server and list its tools. Auth headers are injected
 *  via a custom fetch (the documented way to add headers to the transport). Both
 *  the connect handshake and listTools are bounded so a dead/slow host can't hang
 *  the run; on any failure the half-open transport is closed before rethrowing. */
export async function connectMcpServer(
  cfg: McpServerConfig,
  opts: { timeoutMs?: number; blockPrivate?: boolean; authProvider?: OAuthClientProvider } = {},
): Promise<ConnectedMcp> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const blockPrivate = opts.blockPrivate ?? false;
  const headers = cfg.secrets?.headers ?? {};

  // SSRF: the URL passed assertSafeUrl at upsert, but DNS can change (rebind) and
  // the server can 3xx-bounce us to an internal address. Fail fast here, then let
  // the guarded fetch re-validate every request + redirect hop. Static auth headers
  // are injected; each request is bounded so a stalled host can't hang the run.
  await assertSafeUrl(cfg.url, blockPrivate);
  // The handshake is bounded by withTimeout (below); the fetch timeout is the
  // per-tool-call backstop, so it must be generous — not the connect ceiling.
  const authedFetch = createGuardedFetch({ blockPrivate, timeoutMs: REQUEST_TIMEOUT_MS, headers });

  const client = new Client({ name: "unclaw", version: "0.1.0" });
  // OAuth connectors attach `authProvider` (per-user tokens + auto-refresh); token
  // connectors rely on the static headers injected by authedFetch above.
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    fetch: authedFetch,
    ...(opts.authProvider ? { authProvider: opts.authProvider } : {}),
  });
  try {
    await withTimeout(client.connect(transport), timeoutMs, `mcp connect "${cfg.name}"`);
    const listed = await withTimeout(client.listTools(), timeoutMs, `mcp listTools "${cfg.name}"`);
    return { client, transport, tools: listed.tools as ConnectedMcp["tools"] };
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

export async function disconnectMcp(c: ConnectedMcp): Promise<void> {
  try { await c.transport.terminateSession(); } catch { /* server may not support it */ }
  await c.client.close();
}
