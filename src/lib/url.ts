/**
 * The single source of truth for the app's public origin — used for auth
 * (better-auth baseURL + trustedOrigins) and any absolute link we emit.
 *
 * Resolution order, so the URL is a RUNTIME concern (never baked into the
 * build) and works on a fresh box with zero config:
 *   1. PUBLIC_URL — explicit operator override (set once for prod / behind a
 *      proxy whose forwarded headers we don't fully trust).
 *   2. Proxy headers — X-Forwarded-Proto + X-Forwarded-Host (or Host), so a
 *      reverse proxy / PaaS that terminates TLS gets the right origin for free.
 *   3. http://localhost:3000 — local default; `docker compose up` just works.
 */

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

const firstValue = (header: string | null | undefined) =>
  header?.split(",")[0]?.trim() || undefined;

export function getPublicUrl(opts: {
  env?: Record<string, string | undefined>;
  headers?: Headers;
} = {}): string {
  const env = opts.env ?? process.env;

  const explicit = env.PUBLIC_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);

  const headers = opts.headers;
  if (headers) {
    const host = firstValue(headers.get("x-forwarded-host")) || headers.get("host")?.trim();
    if (host) {
      const proto = firstValue(headers.get("x-forwarded-proto")) || "http";
      return stripTrailingSlash(`${proto}://${host}`);
    }
  }

  return "http://localhost:3000";
}
