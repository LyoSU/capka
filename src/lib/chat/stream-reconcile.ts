/**
 * Stream reconciliation — decide what to do with a realtime streaming event,
 * given the highest `seq` already reflected in the client's copy of a message.
 *
 * Why this exists: SSE has no replay and deltas are incremental, so a client
 * that (re)mounts mid-stream would otherwise append live deltas onto a stale or
 * empty prefix and show a TRUNCATED reply. The DB row is the source of truth;
 * each per-message event carries a monotonic `seq`, and the persisted snapshot
 * records the `streamSeq` it covers. This pure classifier lets the hook tell a
 * covered/next/gapped event apart without any React or network state — so it's
 * trivially unit-testable.
 */
export type ReconcileAction = "apply" | "ignore" | "reconcile";

/**
 * @param appliedSeq highest seq already applied to this message (-1 = none yet)
 * @param eventSeq   the incoming event's seq, or undefined for a publisher that
 *                   doesn't stamp one (Telegram bot, new_message, older workers)
 */
export function classifyStreamEvent(
  appliedSeq: number,
  eventSeq: number | undefined,
): ReconcileAction {
  // Legacy / non-seq publisher — never gate it; behave exactly as before.
  if (eventSeq === undefined) return "apply";
  // Already in the snapshot we reconciled from, or a NOTIFY replay — skip.
  if (eventSeq <= appliedSeq) return "ignore";
  // The next contiguous event — the normal live-streaming path.
  if (eventSeq === appliedSeq + 1) return "apply";
  // A gap: we missed events (reconnected mid-stream, or a dropped NOTIFY).
  // Pull a fresh DB snapshot rather than append onto a stale prefix.
  return "reconcile";
}

/**
 * Decide which held-back events a freshly-loaded snapshot lets us replay.
 *
 * Reconciling by snapshot ALONE cannot catch up with a live stream: the runner
 * persists at most once a second while it publishes ~10 deltas a second, so the
 * snapshot the reload returns is already behind by the time it arrives and the
 * very next delta gaps again. Buffering the gapped events and replaying the ones
 * the snapshot doesn't cover is what closes that distance.
 *
 * Replay stops at the first event that is STILL past a gap — the snapshot hasn't
 * caught up to the hole yet, and applying later text over a hole would show a
 * reply that silently skips a passage. That event and everything after it stay
 * buffered for the next reload.
 *
 * Events arrive in publish order (the runner bumps `seq` synchronously before
 * each publish and NOTIFY is per-channel FIFO), so no sorting is needed.
 */
export function planGapDrain<E extends { messageId: string; seq?: number }>(
  buffered: readonly E[],
  appliedSeq: ReadonlyMap<string, number>,
): { apply: E[]; keep: E[] } {
  const cursors = new Map(appliedSeq);
  const apply: E[] = [];
  for (let i = 0; i < buffered.length; i++) {
    const event = buffered[i];
    const action = classifyStreamEvent(cursors.get(event.messageId) ?? -1, event.seq);
    if (action === "ignore") continue;
    if (action === "reconcile") return { apply, keep: buffered.slice(i) };
    if (typeof event.seq === "number") cursors.set(event.messageId, event.seq);
    apply.push(event);
  }
  return { apply, keep: [] };
}
