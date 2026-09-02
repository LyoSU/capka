/**
 * WHICH "saved to memory" NOTICES THIS BROWSER HAS BEEN DISMISSED, as two pure functions.
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
