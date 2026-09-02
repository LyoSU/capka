import { and, eq, isNull } from "drizzle-orm";
import { apiHandler, requireWriter } from "@/lib/auth";
import { db } from "@/lib/db";
import { spaces, vaultNodes, vaultNotes } from "@/lib/db/schema";
import { forgetNote, noteHead, restoreNote } from "@/lib/vault/notes";

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

  const mine = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt)));
  const allowedSpaceIds = mine.map((s) => s.id);

  const head = await noteHead(noteId, allowedSpaceIds);
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
