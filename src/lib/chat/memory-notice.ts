// TYPE-ONLY, so this module stays import-free at runtime: the client bundle takes it, and
// `turn-writes.ts` opens a database connection at import.
import type { TurnWrite } from "@/lib/vault/turn-writes";

/**
 * THE "saved to memory" NOTICE'S OWN LOGIC, as pure functions: which notices this browser
 * has dismissed, what the notice SAYS, and what each item's Undo DOES.
 *
 * They live outside the component for the reason `formatSource` does: this repo's vitest
 * runs with `environment: "node"` and has no React renderer, so logic inside a component
 * cannot be tested at all — and the bound below is exactly the kind of rule that is
 * silently dropped in a refactor.
 *
 * PER-VIEWER, NOT PER-TURN. A dismissal is a reading preference about one person's own
 * screen, so it belongs in `localStorage` and not in a column: a stored field would be a
 * second thing every writer of a message row has to keep correct, for a value no other
 * client and no server path ever reads.
 *
 * THE BOUND IS STATED AND ENFORCED HERE, which is the repo's rule for anything that
 * populates a store: an uncapped list of message ids grows for the life of the browser
 * profile, and nothing would ever trim it. Newest first and capped, so what falls off the
 * end is the oldest notice — one a person will not meet again, because the transcript it
 * belongs to is far above the fold.
 */
export const DISMISSED_KEY = "capka.memoryNotice.dismissed";
export const DISMISSED_MAX = 50;

/** Tolerant by design: a key written by an older build, hand-edited, or holding anything
 *  but an array of strings reads as "nothing dismissed" rather than throwing inside a
 *  render. Showing a notice that was dismissed is a small annoyance; a thrown parse in a
 *  message component takes the whole transcript with it. */
export function parseDismissed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The list after dismissing one notice. Idempotent — dismissing the same message twice
 *  leaves one entry, not two — and it is the de-duplication that makes the cap mean
 *  fifty distinct notices rather than fifty writes. */
export function nextDismissed(current: string[], messageId: string): string[] {
  return [messageId, ...current.filter((id) => id !== messageId)].slice(0, DISMISSED_MAX);
}

/** A file the turn did not create — the one arm whose undo is not a delete. It is a
 *  function rather than a comparison written twice because the sentence and the button have
 *  to agree about it: a notice reading "saved" over a control that reverts, or the reverse,
 *  is the shape the whole split exists to end. */
const edited = (w: Pick<TurnWrite, "kind" | "revision">) => w.kind === "note" && w.revision > 1;

/**
 * WHAT THE NOTICE'S UNDO ACTUALLY DOES, per item — and it is two different acts.
 *
 * A fact, or a file the turn CREATED, is undone by DELETING it: the turn added it, so
 * removing it leaves the state the person had before. A file the turn only EDITED is undone
 * by REVERTING to the revision before that edit, because deleting there destroys a file —
 * and all of its history — that the person asked only to leave alone. That was the defect:
 * one notice, one verb, and the wrong one on the common path once the manifest started
 * steering the agent to update an existing file rather than add a second.
 *
 * OUT HERE RATHER THAN IN THE COMPONENT, exactly like the dismissal store above and for the
 * same reason: this repo's vitest has no React renderer, so a branch inside `MemoryNotice`
 * cannot be asserted at all — and this one is a decision about destroying a person's data.
 *
 * THE REVERT CARRIES THE HEAD THE NOTICE DISPLAYED, and that is not belt-and-braces. Both
 * numbers are computed from client state: if a later turn edits the same file between this
 * notice's render and the click, `revertTo` is still strictly below the new head, so the
 * server's own "not forward, not a no-op" check passes and an unguarded revert drops that
 * later edit out of the head — for a person who never saw it, and who has no version
 * history to find it in. `expectedRevision` is what turns that into a refusal (409) instead.
 *
 * A DELETE SENDS NO SUCH THING, because there is nothing to be stale about: the wish is
 * that the row not be there, and a row somebody else already removed satisfies it. That
 * asymmetry is the same one that makes 404 a success for a delete and a failure for a
 * revert.
 *
 * The id is ENCODED here, not at the call site: it is part of what "which row" means, and a
 * path built by interpolation somewhere else is the copy that forgets.
 */
export function undoRequest(item: TurnWrite): {
  path: string;
  method: "DELETE" | "PATCH";
  /** The PATCH body, or `null` for a delete — never an empty object, so a caller cannot
   *  send a bodyless PATCH by accident. */
  body: { revertTo: number; expectedRevision: number } | null;
} {
  const path = `/api/memory/${item.kind === "note" ? "notes" : "claims"}/${encodeURIComponent(item.id)}`;
  return edited(item)
    ? { path, method: "PATCH", body: { revertTo: item.revision - 1, expectedRevision: item.revision } }
    : { path, method: "DELETE", body: null };
}

/** The two numbers the notice's sentence is made of. A turn that rewrote an existing file
 *  SAVED nothing, and one sentence over the total is what made the wrong undo read as the
 *  right one — so the counts are split at the same predicate the button is. */
export function noticeCounts(writes: TurnWrite[]): { saved: number; updated: number } {
  const updated = writes.filter(edited).length;
  return { saved: writes.length - updated, updated };
}
