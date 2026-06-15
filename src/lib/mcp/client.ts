import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertSafeUrl } from "@/lib/net/ssrf";
import type { McpServerConfig } from "./types";

export interface ConnectedMcp {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
}

/** Default ceiling for connecting to a single server. `loadMcpTools` runs before
 *  the stream starts, so a hung connect would otherwise delay every task start. */
const CONNECT_TIMEOUT_MS = 5000;

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
  opts: { timeoutMs?: number; blockPrivate?: boolean } = {},
): Promise<ConnectedMcp> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const blockPrivate = opts.blockPrivate ?? false;
  const headers = cfg.secrets?.headers ?? {};

  // SSRF: the URL passed assertSafeUrl at upsert, but DNS can change (rebind) and
  // the server can 3xx-bounce us to an internal address. Re-check the URL here
  // and re-validate every redirect hop before following it — mirrors the
  // `redirect: "manual"` guard in list-models.ts. Loops are bounded.
  await assertSafeUrl(cfg.url, blockPrivate);

  const MAX_REDIRECTS = 5;
  const doFetch = async (input: RequestInfo | URL, init: RequestInit | undefined, depth: number): Promise<Response> => {
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    // Bound each underlying HTTP request too, so a stalled TCP/TLS read aborts
    // rather than waiting on the SDK's own (longer) defaults.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(input, { ...init, headers: h, signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (depth >= MAX_REDIRECTS) throw new Error("Too many redirects");
      const base = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const next = new URL(loc, base);
      await assertSafeUrl(next.toString(), blockPrivate); // re-check each hop
      return doFetch(next, init, depth + 1);
    }
    return res;
  };
  const authedFetch: typeof fetch = (input, init) => doFetch(input, init, 0);

  const client = new Client({ name: "unclaw", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { fetch: authedFetch });
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
