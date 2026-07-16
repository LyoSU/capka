import { isIPv4 } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent } from "undici";

/** Per-request ceiling for OAuth discovery / DCR / token fetches to a user-supplied
 *  provider. Without it, a host that accepts the connection but never answers stalls
 *  the request on undici's ~5-min default — long enough to look like an infinite hang
 *  (e.g. a "Sign in" page that loads forever, or an add that never persists). */
export const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

/**
 * SSRF guard for user-supplied URLs (provider base URLs, MCP server URLs).
 * Link-local / cloud-metadata (169.254/16, fe80::/10) are ALWAYS blocked.
 * Loopback + private ranges are allowed by default (self-hosted gateways),
 * blocked when the admin opts into the stricter policy. Resolves DNS so a
 * public hostname can't point at an internal address.
 */
export function isBlockedAddress(ip: string, blockPrivate: boolean): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIPv4(v4)) {
    const o = v4.split(".").map(Number);
    // Always blocked, regardless of the private-range policy: "this host" (0.0.0.0/8
    // routes to loopback on Linux — a classic metadata/loopback SSRF bypass),
    // link-local / cloud metadata (169.254/16), and multicast + reserved/broadcast
    // (>=224). None is ever a legitimate fetch target.
    if (o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] >= 224) return true;
    if (!blockPrivate) return false;
    if (o[0] === 127) return true;
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  // Always blocked: unspecified "::" (binds/routes to loopback), link-local
  // (fe80::/10), and multicast (ff00::/8).
  if (lower === "::" || lower === "::0") return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (/^ff/.test(lower)) return true;
  if (!blockPrivate) return false;
  if (lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true;
  return false;
}

type ResolvedAddr = { address: string; family: number };

/** Resolve a hostname and refuse if ANY returned address is blocked (conservative:
 *  a host that resolves to a mix of public + private is rejected). Returns the full
 *  validated set so a caller can pin the connection to it. Friendly, non-jargon
 *  errors — these surface directly to the admin. */
async function resolveGuarded(hostname: string, blockPrivate: boolean): Promise<ResolvedAddr[]> {
  let addrs: ResolvedAddr[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address, blockPrivate)) {
      throw new Error("That address isn't allowed. Check the URL or ask your admin about network restrictions.");
    }
  }
  return addrs;
}

function assertHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  return u;
}

/**
 * An undici dispatcher that pins the TCP connection to addresses we already
 * validated, closing the DNS-rebinding window: without it, `assertSafeUrl` resolves
 * the host, then `fetch` resolves it AGAIN at connect time — a hostname that answers
 * a public IP to the first lookup and a private/metadata IP to the second would slip
 * past the guard. We override only the connect-time `lookup`, so the URL hostname is
 * left intact and the Host header, TLS SNI, and certificate validation still use the
 * real hostname — only the resolved IP is fixed to a vetted one.
 */
function pinnedDispatcher(addrs: ResolvedAddr[]): Agent {
  return new Agent({
    connect: {
      // Node's net `lookup` contract: single-address form by default, array form
      // when the caller passes `{ all: true }`. All addrs here already passed
      // isBlockedAddress, so returning any of them is safe.
      lookup: ((_hostname: string, options: unknown, callback: unknown) => {
        const cb = (typeof options === "function" ? options : callback) as (
          err: Error | null,
          address: string | ResolvedAddr[],
          family?: number,
        ) => void;
        const opts = (typeof options === "function" ? {} : options) as { all?: boolean } | undefined;
        if (opts?.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, addrs[0].address, addrs[0].family);
      }) as never,
    },
  });
}

/** Retire a request-scoped Agent without blocking the caller from consuming the
 * response body. `fetch()` resolves at headers, while Agent.close() resolves only
 * after the body/socket is finished; awaiting it here would deadlock streaming
 * callers. Starting the close immediately disables keep-alive reuse and lets
 * undici release the pool as soon as the caller consumes (or aborts) the body. */
function retireDispatcher(dispatcher: Agent): void {
  void dispatcher.close().catch(() => dispatcher.destroy());
}

/** One connection-pinned request with a bounded dispatcher lifecycle. Redirect
 * policy belongs to the caller; createGuardedFetch below uses this once per hop. */
export async function guardedFetchOnce(
  raw: string,
  blockPrivate: boolean,
  init?: RequestInit,
): Promise<Response> {
  const dispatcher = pinnedDispatcher(await resolveGuarded(assertHttpUrl(raw).hostname, blockPrivate));
  try {
    const response = await fetch(raw, { ...init, dispatcher } as RequestInit);
    retireDispatcher(dispatcher);
    return response;
  } catch (error) {
    // No response body can still be using the socket when fetch throws, so tear
    // it down synchronously instead of leaving close() waiting on a broken request.
    dispatcher.destroy();
    throw error;
  }
}

/**
 * A `fetch` that is safe to hand to untrusted-URL machinery (MCP transport, OAuth
 * discovery/token requests). It validates the target of EVERY request — and every
 * 3xx redirect hop — through `assertSafeUrl`, with `redirect: "manual"` so a public
 * host can't bounce us to an internal address (cloud metadata) after the check, and
 * pins each connection to the vetted IP so DNS can't rebind between check and connect.
 * Optionally injects fixed headers and bounds each request with a timeout.
 */
export function createGuardedFetch(opts: {
  blockPrivate: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
}): typeof fetch {
  const MAX_REDIRECTS = 5;
  const doFetch = async (input: RequestInfo | URL, init: RequestInit | undefined, depth: number, originHost: string): Promise<Response> => {
    const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const sameOrigin = new URL(reqUrl).host === originHost;
    const h = new Headers(init?.headers);
    // Inject fixed headers (which may carry credentials, e.g. a GitHub token) ONLY
    // while still on the original host. GitHub's raw/codeload endpoints 3xx to
    // *.githubusercontent.com / object storage, and forwarding the Authorization
    // there would leak the operator's token to an attacker-influenced redirect
    // target. On a cross-host hop, also strip any caller-supplied auth/cookie.
    if (opts.headers && sameOrigin) for (const [k, v] of Object.entries(opts.headers)) h.set(k, v);
    if (!sameOrigin) { h.delete("authorization"); h.delete("cookie"); }
    let signal = init?.signal ?? undefined;
    if (opts.timeoutMs) {
      const ts = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, ts]) : ts;
    }
    const res = await guardedFetchOnce(reqUrl, opts.blockPrivate, {
      ...init,
      headers: h,
      signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (depth >= MAX_REDIRECTS) throw new Error("Too many redirects");
      // Nobody will consume an intermediate redirect body. Cancel it explicitly
      // so that hop's retiring Agent can close now rather than retain a pool until
      // garbage collection or the remote peer times out.
      await res.body?.cancel().catch(() => {});
      return doFetch(new URL(loc, reqUrl), init, depth + 1, originHost);
    }
    return res;
  };
  return ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return doFetch(input, init, 0, new URL(url).host);
  }) as typeof fetch;
}

export async function assertSafeUrl(raw: string, blockPrivate: boolean): Promise<void> {
  await resolveGuarded(assertHttpUrl(raw).hostname, blockPrivate);
}

/**
 * Pre-flight validation that ALSO returns a connection-pinned dispatcher, for
 * callers that do a single request outside `createGuardedFetch` (provider model
 * listing). Pass the dispatcher into `fetch(url, { dispatcher })` so the request
 * connects to the same IP that was just vetted — no rebinding window.
 */
