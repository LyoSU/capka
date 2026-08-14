import { isIPv4, isIPv6 } from "node:net";
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

/**
 * An IPv6 literal as its 16 bytes, or null if it isn't one.
 *
 * Written out rather than leaning on `new URL()` because that normalizes in the WRONG
 * DIRECTION for this check: it rewrites `::ffff:169.254.169.254` — the dotted form the old
 * `startsWith("::ffff:")` slice actually handled — into `::ffff:a9fe:a9fe`, which that slice
 * did not. Deciding a security question on any string shape means deciding it on whichever
 * of a dozen spellings the resolver happened to hand back.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  if (!isIPv6(ip)) return null;
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const toWords = (part: string): number[] => {
    if (!part) return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1];
    // A trailing dotted quad (`::ffff:1.2.3.4`, `::1.2.3.4`) is two words, not one group.
    if (last.includes(".")) {
      const quad = last.split(".").map(Number);
      return [...groups.slice(0, -1).map((g) => parseInt(g, 16)), (quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    }
    return groups.map((g) => parseInt(g, 16));
  };
  const left = toWords(head);
  const right = tail === undefined ? [] : toWords(tail);
  if (tail === undefined && left.length !== 8) return null;
  const words = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[i * 2] = w >> 8; out[i * 2 + 1] = w & 0xff; });
  return out;
}

/**
 * An IPv4 address carried inside an IPv6 one, in dotted form — or null.
 *
 * Three encodings reach the same v4 host and every one of them used to sail past the guard
 * whenever it was spelled in hex: IPv4-mapped (`::ffff:a9fe:a9fe`), the deprecated
 * IPv4-compatible form (`::7f00:1`), and the NAT64 well-known prefix (`64:ff9b::a9fe:a9fe`).
 * A hostile hostname simply publishes an AAAA record in one of them, so the metadata service
 * and loopback were reachable through a check that believed it had covered them.
 */
function embeddedIPv4(b: Uint8Array): string | null {
  const zeros = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  const dotted = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  // ::ffff:a.b.c.d
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return dotted();
  // 64:ff9b::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return dotted();
  // ::a.b.c.d — but NOT `::` or `::1`, which are their own v6 cases below.
  if (zeros(0, 12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1)) return dotted();
  return null;
}

export function isBlockedAddress(ip: string, blockPrivate: boolean): boolean {
  const bytes = ipv6Bytes(ip);
  // Resolve any v6-wrapped v4 address to the v4 rules, which are the ones that actually
  // describe it. Every spelling collapses to one decision here.
  const v4 = bytes ? embeddedIPv4(bytes) ?? ip : ip;
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
  // Anything that is neither a v4 address nor a parseable v6 one is refused rather than
  // allowed: this decides whether to open a connection, and "unrecognized" is not evidence
  // of being safe. The old string tests simply fell through to `return false` here.
  if (!bytes) return true;

  const prefixIsZero = (n: number) => bytes.subarray(0, n).every((x) => x === 0);
  // Always blocked, whatever the private-range policy says: the unspecified address (binds
  // and routes to loopback), link-local (fe80::/10), and multicast (ff00::/8). Tested on
  // bytes, not on the leading characters — `0:0:0:0:0:0:0:1` is a perfectly ordinary way to
  // write loopback and matched none of the old prefixes.
  if (prefixIsZero(16)) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (!blockPrivate) return false;
  if (prefixIsZero(15) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
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
  // The only request headers that survive a cross-origin hop. Deny-by-default, because a
  // blocklist has to enumerate every credential header anybody might send — and the
  // `authorization`/`cookie` pair it used to be already missed the ones every AI SDK
  // actually uses: `x-api-key` (Anthropic), `x-goog-api-key` (Google), `api-key` (Azure).
  // Those arrive in the CALLER's `init.headers`, not in `opts.headers`, so a provider on an
  // admin-supplied base URL could 3xx an operator's key straight to another host. None of
  // the five below carry authority; everything else, known or not, is dropped.
  const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-encoding", "accept-language", "content-type", "user-agent"]);
  const doFetch = async (input: RequestInfo | URL, init: RequestInit | undefined, depth: number, origin: string, stripped: boolean): Promise<Response> => {
    const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // `origin`, not `host`: comparing hosts treated `https://api.example.com` and
    // `http://api.example.com` as the same place, so an https→http redirect kept the
    // Authorization header, any fixed secret headers, the method and the request body — in
    // cleartext. Connection pinning does not help against a downgrade; the bytes are simply
    // no longer encrypted.
    // Trust is monotone: once a hop has gone cross-origin the credentials stay gone, even
    // if a later hop lands back on the original origin. Recomputing this per hop let an
    // attacker-controlled host bounce the chain home and get the headers re-attached — to a
    // PATH it chose. Fetch drops `Authorization` permanently for the same reason.
    const trusted = new URL(reqUrl).origin === origin && !stripped;
    const h = new Headers(init?.headers);
    // Inject fixed headers (which may carry credentials, e.g. a GitHub token) ONLY
    // while still on the original host. GitHub's raw/codeload endpoints 3xx to
    // *.githubusercontent.com / object storage, and forwarding the Authorization
    // there would leak the operator's token to an attacker-influenced redirect
    // target. On a cross-origin hop, everything the caller sent is dropped too unless
    // it is on the deny-by-default allowlist above.
    if (opts.headers && trusted) for (const [k, v] of Object.entries(opts.headers)) h.set(k, v);
    if (!trusted) for (const k of [...h.keys()]) if (!CROSS_ORIGIN_SAFE.has(k)) h.delete(k);
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
      // Follow the redirect the way `fetch` itself does: 303 — and, by universal practice,
      // 301/302 — turn a non-GET into a GET and drop the body. Replaying it verbatim re-sent
      // the caller's request body, which they aimed at the ORIGINAL host, to whatever the
      // redirect names; only 307/308 are defined to preserve method and body.
      const preserve = res.status === 307 || res.status === 308;
      const method = (init?.method ?? "GET").toUpperCase();
      // 307/308 are the two that keep the body, so stripping headers does not protect them:
      // the secret is IN the body. An MCP token request carries `code` + `client_secret` +
      // `code_verifier`; a provider request carries the whole conversation and system prompt.
      // Refused rather than replayed body-less, because silently turning the caller's POST
      // into a GET would be a confusing failure at the far end instead of an honest one here.
      if (preserve && init?.body != null && next.origin !== origin) {
        throw new UnsafeUrlError("blocked", "That address isn't allowed. Check the URL or ask your admin about network restrictions.");
      }
      const nextInit = preserve || method === "GET" || method === "HEAD"
        ? init
        : { ...init, method: "GET", body: undefined };
      return doFetch(next, nextInit, depth + 1, origin, stripped || next.origin !== origin);
    }
    return res;
  };
  return ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return doFetch(input, init, 0, new URL(url).origin, false);
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
