import { isIPv4 } from "node:net";
import { lookup } from "node:dns/promises";

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
    if (o[0] === 169 && o[1] === 254) return true;
    if (!blockPrivate) return false;
    if (o[0] === 127) return true;
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (/^fe[89ab]/.test(lower)) return true;
  if (!blockPrivate) return false;
  if (lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true;
  return false;
}

/**
 * A `fetch` that is safe to hand to untrusted-URL machinery (MCP transport, OAuth
 * discovery/token requests). It validates the target of EVERY request — and every
 * 3xx redirect hop — through `assertSafeUrl`, with `redirect: "manual"` so a public
 * host can't bounce us to an internal address (cloud metadata) after the check.
 * Optionally injects fixed headers and bounds each request with a timeout.
 */
export function createGuardedFetch(opts: {
  blockPrivate: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
}): typeof fetch {
  const MAX_REDIRECTS = 5;
  const doFetch = async (input: RequestInfo | URL, init: RequestInit | undefined, depth: number): Promise<Response> => {
    const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    await assertSafeUrl(reqUrl, opts.blockPrivate);
    const h = new Headers(init?.headers);
    if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) h.set(k, v);
    let signal = init?.signal ?? undefined;
    if (opts.timeoutMs) {
      const ts = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, ts]) : ts;
    }
    const res = await fetch(input, { ...init, headers: h, signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (depth >= MAX_REDIRECTS) throw new Error("Too many redirects");
      return doFetch(new URL(loc, reqUrl), init, depth + 1);
    }
    return res;
  };
  return ((input, init) => doFetch(input, init, 0)) as typeof fetch;
}

export async function assertSafeUrl(raw: string, blockPrivate: boolean): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${u.hostname}`);
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address, blockPrivate)) {
      throw new Error("That address isn't allowed. Check the URL or ask your admin about network restrictions.");
    }
  }
}
