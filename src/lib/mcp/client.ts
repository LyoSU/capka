import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { assertSafeUrl, createGuardedFetch } from "@/lib/net/ssrf";
import { makeElicitHandler } from "./elicitation";
import { SandboxStdioTransport } from "./stdio-transport";
import type { McpServerConfig } from "./types";

/** Run context a connector needs to elicit input from the user mid-tool-call.
 *  Present only during a live turn (loadMcpTools threads it through). */
export type ElicitContext = { userId: string; chatId: string; messageId: string };

export interface ConnectedMcp {
  client: Client;
  transport: Transport;
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
}

/** Default ceiling for connecting to a single server. `loadMcpTools` runs before
 *  the stream starts, so a hung connect would otherwise delay every task start. */
const CONNECT_TIMEOUT_MS = 5000;

/** stdio servers self-install on first use (npx/uvx fetches the package) and the
 *  sandbox is ephemeral, so the cold-start handshake is far slower than a remote
 *  HTTP server. A fast crash still rejects immediately (the bridge stream closes),
 *  so this ceiling only bites a genuinely slow install. */
const STDIO_CONNECT_TIMEOUT_MS = 90_000;

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
  opts: { timeoutMs?: number; blockPrivate?: boolean; authProvider?: OAuthClientProvider; sessionKey?: string; elicitContext?: ElicitContext } = {},
): Promise<ConnectedMcp> {
  const timeoutMs = opts.timeoutMs ?? (cfg.transport === "stdio" ? STDIO_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
  const blockPrivate = opts.blockPrivate ?? false;

  // Declare the elicitation capability + register a handler only during a live
  // turn (elicitContext present) — the handler needs the run's chat/message to
  // surface the question card and poll for the answer. Off-turn (cache warm), the
  // client advertises no elicitation support, so a server won't try to elicit.
  const client = new Client(
    { name: "capka", version: "0.1.0" },
    opts.elicitContext ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.elicitContext) {
    client.setRequestHandler(ElicitRequestSchema, makeElicitHandler(opts.elicitContext));
  }
  let transport: Transport;

  if (cfg.transport === "stdio") {
    // Local server: runs inside the session sandbox, bridged via the controller.
    // No URL / SSRF — the trust boundary is the sandbox, not a remote host.
    if (!cfg.command) throw new Error(`stdio connector "${cfg.name}" has no command`);
    if (!opts.sessionKey) throw new Error(`no sandbox session for stdio connector "${cfg.name}"`);
    transport = new SandboxStdioTransport(opts.sessionKey, cfg.name, {
      command: cfg.command,
      args: cfg.args,
      env: cfg.secrets?.env,
    });
  } else {
    const headers = cfg.secrets?.headers ?? {};
    // SSRF: the URL passed assertSafeUrl at upsert, but DNS can change (rebind) and
    // the server can 3xx-bounce us to an internal address. Fail fast here, then let
    // the guarded fetch re-validate every request + redirect hop. Static auth headers
    // are injected; each request is bounded so a stalled host can't hang the run.
    await assertSafeUrl(cfg.url, blockPrivate);
    // The handshake is bounded by withTimeout (below); the fetch timeout is the
    // per-tool-call backstop, so it must be generous — not the connect ceiling.
    const authedFetch = createGuardedFetch({ blockPrivate, timeoutMs: REQUEST_TIMEOUT_MS, headers });
    // OAuth connectors attach `authProvider` (per-user tokens + auto-refresh); token
    // connectors rely on the static headers injected by authedFetch above.
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      fetch: authedFetch,
      ...(opts.authProvider ? { authProvider: opts.authProvider } : {}),
    });
  }
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
  // Streamable-HTTP transports can end the server session; stdio/others can't.
  const t = c.transport as Partial<StreamableHTTPClientTransport>;
  if (typeof t.terminateSession === "function") {
    try { await t.terminateSession(); } catch { /* server may not support it */ }
  }
  await c.client.close();
}
