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
/**
 * Why a URL was refused, as a value rather than as prose.
 *
 * The four refusal sites below differ only by message text, and those messages are
 * deliberately friendly copy that surfaces straight to an admin (`mcp/service.ts`
 * re-wraps `e.message` as a `ValidationError`). Classifying on that text would let a
 * copy edit silently flip a security verdict, so the reason travels beside the message
 * instead of inside it (docs/plugin-install-review-spec.md §5).
 */
export type UnsafeUrlReason = "blocked" | "unresolved" | "invalid";

export class UnsafeUrlError extends Error {
  readonly reason: UnsafeUrlReason;
  constructor(reason: UnsafeUrlReason, message: string) {
    super(message);
    this.name = "UnsafeUrlError";
    this.reason = reason;
  }
}

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
    throw new UnsafeUrlError("unresolved", `Could not resolve host: ${hostname}`);
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address, blockPrivate)) {
      throw new UnsafeUrlError("blocked", "That address isn't allowed. Check the URL or ask your admin about network restrictions.");
    }
  }
  return addrs;
}

/**
 * `URL.hostname` returns an IPv6 literal WITH its brackets (`"[::1]"`), and `dns.lookup`
 * rejects that form — so every IPv6 literal URL used to fail resolution and be classified
 * `unresolved`, which meant `isBlockedAddress` never saw the address at all and its whole
 * v6 branch was dead on this path. Fail-closed, but wrong: a legitimate v6 endpoint could
 * never be used, and the classification said "cannot resolve" about an address that is
 * right there in the URL.
 */
function bareHostname(u: URL): string {
  return u.hostname.startsWith("[") && u.hostname.endsWith("]") ? u.hostname.slice(1, -1) : u.hostname;
}

function assertHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid", "Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError("invalid", "URL must use http or https");
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
  const dispatcher = pinnedDispatcher(await resolveGuarded(bareHostname(assertHttpUrl(raw)), blockPrivate));
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
  const doFetch = async (input: RequestInfo | URL, init: RequestInit | undefined, depth: number, origin: string): Promise<Response> => {
    const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // `origin`, not `host`: comparing hosts treated `https://api.example.com` and
    // `http://api.example.com` as the same place, so an https→http redirect kept the
    // Authorization header, any fixed secret headers, the method and the request body — in
    // cleartext. Connection pinning does not help against a downgrade; the bytes are simply
    // no longer encrypted.
    const sameOrigin = new URL(reqUrl).origin === origin;
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
      // A downgrade is refused outright rather than merely stripped of credentials. Following
      // it would still send the method and body over cleartext to a host that just asked for
      // exactly that, which is the shape of the attack, not a side effect of it.
      const next = new URL(loc, reqUrl);
      if (new URL(reqUrl).protocol === "https:" && next.protocol === "http:") {
        await res.body?.cancel().catch(() => {});
        throw new UnsafeUrlError("blocked", "That address isn't allowed. Check the URL or ask your admin about network restrictions.");
      }
      // Nobody will consume an intermediate redirect body. Cancel it explicitly
      // so that hop's retiring Agent can close now rather than retain a pool until
      // garbage collection or the remote peer times out.
      await res.body?.cancel().catch(() => {});
      return doFetch(next, init, depth + 1, origin);
    }
    return res;
  };
  return ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return doFetch(input, init, 0, new URL(url).origin);
  }) as typeof fetch;
}

export async function assertSafeUrl(raw: string, blockPrivate: boolean): Promise<void> {
  await resolveGuarded(bareHostname(assertHttpUrl(raw)), blockPrivate);
}

/** What a preflight saw. `allowed` is the only value that is not a refusal. */
export type UrlVerdict = "allowed" | UnsafeUrlReason;

/**
 * `assertSafeUrl` as a verdict rather than an exception, for a review that has to
 * describe every connector including the unsafe ones — a throw would abort the whole
 * review over one bad URL.
 *
 * This is a FOURTH check for display, not a replacement for any of the three that
 * enforce: `assertSafeUrl` still runs in `upsertServer` and in `connectMcpServer`, and
 * the guarded fetch still re-validates every request and redirect hop
 * (docs/plugin-install-review-spec.md §3, invariant 1). Anything it cannot explain is
 * reported as `blocked`, because a verdict computed for display still decides
 * `cannot_apply`, and an internal error must never read as permission.
 */
export async function preflightUrl(raw: string, blockPrivate: boolean): Promise<UrlVerdict> {
  try {
    await assertSafeUrl(raw, blockPrivate);
    return "allowed";
  } catch (e) {
    return e instanceof UnsafeUrlError ? e.reason : "blocked";
  }
}
