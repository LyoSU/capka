/**
 * Reconcile a server-loaded conversation with optimistic messages whose POST is
 * still in flight.
 *
 * The chat hook replaces its in-memory list with the server's active path on
 * every `loadHistory()`. But a `task:finish` for a PRIOR turn can fire — and
 * trigger that reload — before a just-queued message's `POST /api/chat` has
 * committed. The reloaded path then wouldn't include that message, so a blind
 * replace makes the queued message vanish from the chat until the next reload.
 *
 * Re-append any pending message the server path doesn't yet contain (dedup by
 * id, append in send order at the tail — a queued follow-up always continues the
 * latest leaf). Once the server has caught up and a reload DOES contain the id,
 * the caller drops it from `pending` (see `pendingStillUnknown`).
 */
export function mergePendingMessages<T extends { id: string }>(history: T[], pending: T[]): T[] {
  if (pending.length === 0) return history;
  const known = new Set(history.map((m) => m.id));
  const extra = pending.filter((m) => !known.has(m.id));
  return extra.length ? [...history, ...extra] : history;
}

/**
 * The pending entries the server history does NOT yet know about. Used to prune
 * `pending` after a reload: an entry the server now returns is durably persisted,
 * so a future reload will carry it on its own and it no longer needs preserving.
 */
export function pendingStillUnknown<T extends { id: string }>(history: T[], pending: T[]): T[] {
  if (pending.length === 0) return pending;
  const known = new Set(history.map((m) => m.id));
  return pending.filter((m) => !known.has(m.id));
}
