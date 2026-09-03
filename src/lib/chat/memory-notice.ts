// TYPE-ONLY, so this module stays import-free at runtime: the client bundle takes it, and
// `turn-writes.ts` opens a database connection at import.
import type { TurnWrite } from "@/lib/vault/turn-writes";

/**
 * THE "saved to memory" ROW'S OWN LOGIC, as pure functions: what the row SAYS about an item
 * and what its Undo DOES. They live outside the component for the reason `formatSource`
 * does: this repo's vitest runs with `environment: "node"` and has no React renderer, so
 * logic inside a component cannot be tested at all — and the decision below is about
 * destroying a person's data.
 */

/** A file the turn did not create — the one arm whose undo is not a delete. Exported rather
 *  than compared twice because the row's sentence and its button have to agree about it: a
 *  row reading "saved" over a control that reverts, or the reverse, is the shape the whole
 *  split exists to end. */
export const edited = (w: Pick<TurnWrite, "kind" | "revision">) => w.kind === "note" && w.revision > 1;

/**
 * WHAT THE ROW'S UNDO ACTUALLY DOES, per item — and it is two different acts.
 *
 * A fact, or a file the turn CREATED, is undone by DELETING it: the turn added it, so
 * removing it leaves the state the person had before. A file the turn only EDITED is undone
 * by REVERTING to the revision before that edit, because deleting there destroys a file —
 * and all of its history — that the person asked only to leave alone. That was the defect:
 * one notice, one verb, and the wrong one on the common path once the manifest started
 * steering the agent to update an existing file rather than add a second.
 *
 * THE REVERT CARRIES THE HEAD THE ROW DISPLAYED, and that is not belt-and-braces. Both
 * numbers are computed from client state: if a later turn edits the same file between this
 * row's render and the click, `revertTo` is still strictly below the new head, so the
 * server's own "not forward, not a no-op" check passes and an unguarded revert drops that
 * later edit out of the head — for a person who never saw it, and who has no version
 * history to find it in. `expectedRevision` is what turns that into a refusal (409) instead.
 *
 * A DELETE SENDS NO SUCH THING, because there is nothing to be stale about: the wish is
 * that the row not be there, and a row somebody else already removed satisfies it.
 *
 * A 404 is treated the same way on BOTH verbs, and that is not the asymmetry above leaking:
 * from this row a 404 on a revert can only mean the item is gone, because `not_revertable`
 * — the route's other 404 — is unreachable once `expectedRevision` matches the head. So the
 * item leaves the rail either way, and the case that genuinely differs is the 409, which
 * only a revert can receive.
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
