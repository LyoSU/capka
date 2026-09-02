import { and, eq, isNull } from "drizzle-orm";
import { apiHandler, requireWriter } from "@/lib/auth";
import { db } from "@/lib/db";
import { spaces, vaultNodes, vaultNotes } from "@/lib/db/schema";
import { forgetNote, noteHead, restoreNote, revertNote } from "@/lib/vault/notes";

/** The spaces this person owns and has not retired — which is what "yours" means on every
 *  verb here. One helper rather than the same three-line select twice: two copies is how one
 *  of them loses the `retired_at` clause. */
async function ownedSpaceIds(userId: string): Promise<string[]> {
  const mine = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt)));
  return mine.map((s) => s.id);
}

/**
 * The person's delete for a NOTE — the sibling of the claim route next door, and the
 * reason `forgetNote` had to grow an optional task bound.
 *
 * The agent's `memory_forget` may only undo a note it wrote in the same turn (§4.9),
 * because a model holding a handle has not thereby shown that the person asked for
 * anything. Here the person is asking: authority is established by the SESSION, and the
 * request carries no words at all, so there is nothing a page the agent fetched could have
 * supplied. That is the same argument the claim route makes, and it is why the same-task
 * bound is not loosened for the agent but simply absent for the owner.
 *
 * Goes through `forgetNote`, never a bare delete: the node's tombstone, the cascade of its
 * live edges and the audit event with actor `user` all live with it, and a route reaching
 * around it would leave the note's edges live and its search projection in place.
 *
 * The revision is read here rather than sent by the client, exactly as the claim route
 * reads it: this is a low-contention surface, and the alternative — the browser echoing a
 * revision back — buys optimistic concurrency a person cannot act on, since there is no
 * "someone else changed this, look again" step for a person undoing their own note.
 */
export const DELETE = apiHandler(async (_req: Request, ctx: { params: Promise<{ noteId: string }> }) => {
  const { userId } = await requireWriter();
  const { noteId } = await ctx.params;

  const head = await noteHead(noteId, await ownedSpaceIds(userId));
  // One answer for "no such note" and "not yours", deliberately: telling them apart would
  // make another user's note ids probeable one at a time.
  if (!head) return Response.json({ error: "not_found" }, { status: 404 });

  const res = await forgetNote({
    noteId: head.id,
    spaceId: head.spaceId,
    expectedRevision: head.revision,
    // NO `createdTaskId`. The whole point of the route: the owner's delete is bounded by
    // nobody's task, and the audit event records `user` rather than `agent`.
    actor: { kind: "user", id: userId },
  });
  // Only reachable if the head moved between the read and the guarded delete — which, for
  // a person removing their own note, means it is already gone.
  return res.ok ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
});

/**
 * PUT THE NOTE BACK — what the memory page's Undo toast calls.
 *
 * A POST beside the DELETE rather than a `/restore` sub-route, for the reason the memory
 * route's own docstring gives about `?q=`: a NEW route directory is not picked up by the
 * dev watcher over this repo's bind mount, so Next answers 404 before any handler runs, and
 * that reads exactly like a logic bug. One directory, two verbs, one thing addressed.
 *
 * IT CANNOT USE `noteHead`, and that is the whole difference from the delete above:
 * `noteHead` says nothing about the node's tombstone (by design — `memory_open` and the
 * write tools call it for notes that are live by construction), so ownership has to be
 * established against a row that IS deleted. Hence the explicit join here: the note, its
 * space, and that space being one this user owns and has not retired.
 *
 * The 404 is one answer for "no such note", "not yours" and "not deleted", exactly as the
 * delete's is — telling them apart would make another user's note ids probeable one at a
 * time, and the third case is not a failure anyway (see `restoreNote`).
 */
export const POST = apiHandler(async (_req: Request, ctx: { params: Promise<{ noteId: string }> }) => {
  const { userId } = await requireWriter();
  const { noteId } = await ctx.params;

  const [mine] = await db
    .select({ spaceId: vaultNotes.spaceId })
    .from(vaultNotes)
    .innerJoin(vaultNodes, and(eq(vaultNodes.id, vaultNotes.id), eq(vaultNodes.spaceId, vaultNotes.spaceId)))
    .innerJoin(spaces, eq(spaces.id, vaultNotes.spaceId))
    .where(
      and(
        eq(vaultNotes.id, noteId),
        eq(spaces.ownerUserId, userId),
        isNull(spaces.retiredAt),
      ),
    )
    .limit(1);
  if (!mine) return Response.json({ error: "not_found" }, { status: 404 });

  const res = await restoreNote({
    noteId,
    spaceId: mine.spaceId,
    // `user`, never `agent`: there is no tool that can undo the person's delete, and the
    // audit log is where that stays true.
    actor: { kind: "user", id: userId },
  });
  return res.ok ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
});

/**
 * UNDO AN EDIT — the chat notice's Undo for a turn that changed a file it did not create.
 *
 * A THIRD VERB ON THE SAME DIRECTORY, because the three are three things one can do to one
 * note and a new route directory is not picked up by the dev watcher over this repo's bind
 * mount. DELETE removes the file, POST puts a removed one back, PATCH puts its earlier WORDS
 * back — and the last one exists because the notice used to answer an edited file's Undo
 * with DELETE, taking a file and all its history that the person only asked to leave alone.
 *
 * THE REVISION COMES FROM THE CLIENT here, unlike the delete's, and that is not a relaxation
 * of the same rule: the delete reads the head because there is nothing for a person to
 * choose, while a revert is a choice OF a revision — the notice sends the one before the
 * turn it is undoing. `revertNote` refuses anything that is not strictly below the current
 * head, so a stale page cannot revert forward or turn a revert into a no-op that reports
 * success.
 *
 * IT ALSO TAKES THE HEAD THE CLIENT SAW, and that is the case the two clauses above do NOT
 * cover: a later turn edits the same file between the notice's render and the click, the
 * requested target is still strictly below the new head, and an unguarded revert therefore
 * succeeds — dropping an edit the person never saw, with no version-history surface to
 * notice it in. `expectedRevision` is optional (a caller that has just read the head is not
 * stale) and the notice always sends it.
 *
 * A LOST CAS IS A 409, NOT A 404, and the difference is what the client can do next. A 404
 * means the row is gone, which for a DELETE satisfies the wish — the notice drops the item
 * and says nothing. For a revert the edit is still there, so collapsing `revision_moved`
 * into 404 removed the one control that could retry and reported success for a file it had
 * not changed. The 409 carries the head it found, and the notice surfaces it as a failure.
 *
 * One 400 for a body that is not a revision, one 409 for a head that moved, and one 404 for
 * everything else — no such note, not yours, deleted since, or nothing earlier to go back
 * to. See `revertNote`: telling THOSE apart would make another user's note ids probeable
 * one at a time, which a 409 does not, since it is only reachable for a note the ownership
 * read above already admitted.
 */
export const PATCH = apiHandler(async (req: Request, ctx: { params: Promise<{ noteId: string }> }) => {
  const { userId } = await requireWriter();
  const { noteId } = await ctx.params;

  const body = await req.json().catch(() => null);
  const { revertTo, expectedRevision } = (body ?? {}) as { revertTo?: unknown; expectedRevision?: unknown };
  const isRevision = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
  // `expectedRevision` is optional, so `undefined` passes and anything else that is not a
  // revision does not: a client sending a malformed guard must not have it silently dropped
  // and get the unguarded write it was trying to avoid.
  if (!isRevision(revertTo) || (expectedRevision !== undefined && !isRevision(expectedRevision))) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const head = await noteHead(noteId, await ownedSpaceIds(userId));
  if (!head) return Response.json({ error: "not_found" }, { status: 404 });

  const res = await revertNote({
    noteId: head.id,
    spaceId: head.spaceId,
    toRevision: revertTo,
    expectedRevision,
    // `user`, never `agent`: a model that could undo its own edit on the person's behalf
    // would make the notice's Undo a thing the agent can press.
    actor: { kind: "user", id: userId },
  });
  if (res.ok) return Response.json({ ok: true, revision: res.revision });
  return res.reason === "revision_moved"
    ? Response.json({ error: "revision_moved", revision: res.revision }, { status: 409 })
    : Response.json({ error: "not_found" }, { status: 404 });
});
