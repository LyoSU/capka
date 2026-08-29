import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  auditEvents,
  knowledgeSources,
  memoryCandidates,
  spaces,
  vaultClaims,
  vaultNotes,
} from "@/lib/db/schema";

/** A DB handle: the pool, or the caller's transaction. Every function here sends
 *  ALL of its statements through it — quietly falling back to the module-level
 *  `db` inside someone else's transaction would break atomicity in a way no test
 *  would ever see. */
export type Ex = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The knowledge space for an owner: one per user, one per project (a project's
 *  chats share it). For a user space `ownerUserId` IS the refId; for a project the
 *  caller passes it, since it already holds the project row and an extra SELECT
 *  here would sit on the hot path of a turn. */
export async function getOrCreateSpace(
  scope: { type: "user"; refId: string } | { type: "project"; refId: string; ownerUserId: string },
  ex: Ex = db,
): Promise<string> {
  const where = and(eq(spaces.type, scope.type), eq(spaces.refId, scope.refId));
  const found = await ex.select({ id: spaces.id }).from(spaces).where(where).limit(1);
  if (found[0]) return found[0].id;
  // Concurrent first writers race on uniq_spaces_type_ref; the loser writes
  // nothing and reads back the winner's row.
  await ex
    .insert(spaces)
    .values({
      id: nanoid(),
      type: scope.type,
      refId: scope.refId,
      ownerUserId: scope.type === "user" ? scope.refId : scope.ownerUserId,
    })
    .onConflictDoNothing();
  const [row] = await ex.select({ id: spaces.id }).from(spaces).where(where).limit(1);
  if (!row) throw new Error(`space ${scope.type}:${scope.refId} vanished after insert`);
  return row.id;
}

/** A memory topic is a note of kind `memory_topic`; the partial unique on
 *  (space, title) is scoped to that kind, so it is the same race and the same
 *  resolution as above. */
export async function getOrCreateTopicNote(spaceId: string, title: string, ex: Ex = db): Promise<string> {
  const where = and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.title, title), eq(vaultNotes.kind, "memory_topic"));
  const found = await ex.select({ id: vaultNotes.id }).from(vaultNotes).where(where).limit(1);
  if (found[0]) return found[0].id;
  await ex.insert(vaultNotes).values({ id: nanoid(), spaceId, title, kind: "memory_topic" }).onConflictDoNothing();
  const [row] = await ex.select({ id: vaultNotes.id }).from(vaultNotes).where(where).limit(1);
  if (!row) throw new Error(`memory topic "${title}" vanished after insert`);
  return row.id;
}

/** Deleting a project kills its MEMORY (claims, topics, candidates) but keeps its
 *  KNOWLEDGE: `chats.projectId` is SET NULL, so chats outlive the project and
 *  their citations still pin versions. Hence sources are soft-deleted and
 *  versions/fragments/citations are left alone. The space row also stays; purge
 *  by owner_user_id collects it (full GC is plan D).
 *
 *  Idempotent, because teardown is re-driven from the worker tick: exactly one
 *  `space.retire` event is written per space. */
export async function retireProjectSpace(projectId: string, ex?: Ex): Promise<void> {
  if (!ex) return db.transaction((tx) => retireProjectSpace(projectId, tx));

  const [space] = await ex
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.type, "project"), eq(spaces.refId, projectId)))
    .limit(1)
    // Lock the space row for the transaction: "no event yet" is a read-modify-write,
    // and without this two concurrent retires (the request and the worker tick, if
    // the first overran the 30-second grace) would both read "none" and each write
    // an event. The old "was there anything to remove" condition was race-safe only
    // by accident — one of the two transactions would have deleted nothing.
    .for("update");
  if (!space) return;
  const spaceId = space.id;

  // note_claims and claim_evidence cascade from the notes/claims below.
  const claims = await ex.delete(vaultClaims).where(eq(vaultClaims.spaceId, spaceId)).returning({ id: vaultClaims.id });
  const notes = await ex.delete(vaultNotes).where(eq(vaultNotes.spaceId, spaceId)).returning({ id: vaultNotes.id });
  const candidates = await ex
    .delete(memoryCandidates)
    .where(eq(memoryCandidates.spaceId, spaceId))
    .returning({ id: memoryCandidates.id });
  const sources = await ex
    .update(knowledgeSources)
    .set({ deletedAt: new Date() })
    .where(and(eq(knowledgeSources.spaceId, spaceId), isNull(knowledgeSources.deletedAt)))
    .returning({ id: knowledgeSources.id });

  // Exactly one event per project deletion, and the condition is "no event yet",
  // NOT "there was something to remove": a space the user emptied by hand must
  // still leave a trace, or "no event" reads the same for "the space was empty"
  // and "teardown never ran" — and with retryPendingProjectTeardowns that is a
  // live operational difference. The lookup rides idx_audit_space_created.
  const [priorEvent] = await ex
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.spaceId, spaceId), eq(auditEvents.action, "space.retire")))
    .limit(1);
  if (priorEvent) return;
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId,
    actor: { kind: "system" },
    action: "space.retire",
    subjectType: "space",
    subjectId: spaceId,
    payload: {
      projectId,
      claims: claims.length,
      notes: notes.length,
      candidates: candidates.length,
      sources: sources.length,
    },
  });
}

/** A deleted user's knowledge does not outlive them. Called INSIDE the same
 *  transaction as `db.delete(users)` and AFTER it: the users cascade has by then
 *  removed chats → messages → citations, so no pins remain and the space cascade
 *  runs all the way through. `owner_user_id` is denormalized precisely for this —
 *  it also finds the spaces of LONG-deleted projects, whose rows are gone.
 *  A surviving citation (an anomaly) raises RESTRICT and rolls back the WHOLE
 *  transaction: the user stays, an admin sees the error and retries — atomic by
 *  construction, so no separate retry path is needed. */
export async function purgeUserSpaces(userId: string, ex: Ex = db): Promise<void> {
  await ex.delete(spaces).where(eq(spaces.ownerUserId, userId));
}
