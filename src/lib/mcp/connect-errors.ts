/**
 * Last connect error per MCP server, kept in-process so the connectors UI can show
 * *why* a server didn't load — especially stdio servers, which can't be probed
 * outside a run (the health probe skips them). The worker records here when a
 * connect fails at run time; the health endpoint (same process) reads it.
 */
const errors = new Map<string, { detail: string; at: number }>();
const TTL_MS = 10 * 60_000;

export function recordConnectError(id: string | undefined, detail: string): void {
  if (!id) return;
  errors.set(id, { detail: detail.slice(0, 400), at: Date.now() });
}

export function clearConnectError(id: string | undefined): void {
  if (id) errors.delete(id);
}

export function getConnectError(id: string): string | null {
  const e = errors.get(id);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { errors.delete(id); return null; }
  return e.detail;
}

/**
 * Connect backoff: did this server fail to connect within the last `withinMs`?
 *
 * Every agent run reconnects all enabled connectors, so a persistently broken
 * one (e.g. a connector whose token was revoked) was re-dialed on every single
 * run — adding the full connect timeout to each turn's startup and flooding the
 * logs. Skipping a server that just failed avoids hammering a dead endpoint,
 * while the short window means a fixed/re-authorized server is retried again
 * soon. `clearConnectError` (called on a successful connect or a config edit)
 * cancels the backoff immediately, so a recovery is never delayed.
 */
export function recentlyFailed(id: string, withinMs: number, now: () => number = Date.now): boolean {
  const e = errors.get(id);
  return !!e && now() - e.at < withinMs;
}
