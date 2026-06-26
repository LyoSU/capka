/**
 * Last connect error per (user, MCP server), kept in-process so the connectors UI
 * can show *why* a server didn't load — especially stdio servers, which can't be
 * probed outside a run (the health probe skips them). The worker records here when
 * a connect fails at run time; the health endpoint (same process) reads it.
 *
 * Keyed per USER, not per server: a `system`/shared connector is one row seen by
 * everyone, but its connect outcome is per-user (OAuth tokens, per-user secrets).
 * Keying on the bare server id would let one user's sign-in failure back off the
 * connector for — and leak its error detail to — every other user.
 */
const errors = new Map<string, { detail: string; at: number }>();
const TTL_MS = 10 * 60_000;

function key(userId: string, id: string): string {
  return `${userId}:${id}`;
}

export function recordConnectError(userId: string, id: string | undefined, detail: string): void {
  if (!id) return;
  errors.set(key(userId, id), { detail: detail.slice(0, 400), at: Date.now() });
}

export function clearConnectError(userId: string, id: string | undefined): void {
  if (id) errors.delete(key(userId, id));
}

export function getConnectError(userId: string, id: string): string | null {
  const k = key(userId, id);
  const e = errors.get(k);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { errors.delete(k); return null; }
  return e.detail;
}

/**
 * Connect backoff: did this server fail to connect for THIS user within the last
 * `withinMs`?
 *
 * Every agent run reconnects all enabled connectors, so a persistently broken one
 * (e.g. a connector whose token was revoked) was re-dialed on every single run —
 * adding the full connect timeout to each turn's startup and flooding the logs.
 * Skipping a server that just failed avoids hammering a dead endpoint, while the
 * short window means a fixed/re-authorized server is retried again soon.
 * `clearConnectError` (called on a successful connect or a config edit) cancels
 * the backoff immediately, so a recovery is never delayed.
 */
export function recentlyFailed(userId: string, id: string, withinMs: number, now: () => number = Date.now): boolean {
  const e = errors.get(key(userId, id));
  return !!e && now() - e.at < withinMs;
}
