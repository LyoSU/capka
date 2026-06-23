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
