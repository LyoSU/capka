import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  auditEvents,
  knowledgeSources,
  memoryCandidates,
  projects,
  spaces,
  vaultClaims,
  vaultNodes,
  vaultNotes,
} from "@/lib/db/schema";
import { deleteSpaceNodes, insertNode } from "./nodes";
import { projectNoteDoc } from "./search-documents";

/** A DB handle: the pool, or the caller's transaction. Every function here sends
 *  ALL of its statements through it — quietly falling back to the module-level
 *  `db` inside someone else's transaction would break atomicity in a way no test
 *  would ever see. */
export type Ex = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The knowledge space for an owner: one per user, one per project (a project's
 *  chats share it). For a user space `ownerUserId` IS the refId; for a project the
 *  caller passes it, since it already holds the project row and an extra SELECT
 *  here would sit on the hot path of a turn.
 *
 *  Returns a RETIRED space as readily as a live one, and that is deliberate: whether a
 *  write may happen is `spaceAcceptsWrites`' decision, taken inside the writer's own
 *  transaction, and answering it here would answer it about a moment instead. What
 *  this guarantees is only that a project whose teardown has run comes back as the
 *  tombstone that teardown left, never as a fresh live row. */
export async function getOrCreateSpace(
  scope: { type: "user"; refId: string } | { type: "project"; refId: string; ownerUserId: string },
  ex: Ex = db,
): Promise<string> {
  const where = and(eq(spaces.type, scope.type), eq(spaces.refId, scope.refId));
  const read = () => ex.select({ id: spaces.id, ownerUserId: spaces.ownerUserId }).from(spaces).where(where).limit(1);

  /**
   * The lookup is by (type, ref_id), so whoever called FIRST pins `owner_user_id`
   * and every later caller used to be handed the row without a word. One wrong first
   * call therefore left a project's knowledge outside its real owner's
   * `purgeUserSpaces` forever — a deleted user's facts living on, and nothing
   * anywhere recording the divergence. Both read paths go through here: the race
   * loser reads back the WINNER's row, which is the same situation.
   *
   * THROW rather than update-and-audit, and the choice matters. The owner decides
   * whose deletion takes this space with it, so rewriting it on a caller's say-so
   * lets a bug hand a whole space to someone else — a privacy-relevant write, and
   * "last caller wins" is no more truthful than "first caller wins". Refusing keeps
   * the recorded owner and makes the disagreement loud instead of durable. Projects
   * are single-owner (`projects.user_id`, no membership table), so a legitimate
   * mismatch does not exist today; if ownership transfer is ever built it belongs in
   * a function that says so, not in a get-or-create on the hot path of a turn.
   *
   * Only project spaces can diverge: for a user space the owner IS the refId, written
   * from the very value the lookup matched on.
   */
  const owned = (row: { id: string; ownerUserId: string }) => {
    if (scope.type === "project" && row.ownerUserId !== scope.ownerUserId) {
      throw new Error(`space project:${scope.refId} is owned by ${row.ownerUserId}, not ${scope.ownerUserId}`);
    }
    return row.id;
  };

  const found = await read();
  if (found[0]) return owned(found[0]);
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
  const [row] = await read();
  if (!row) throw new Error(`space ${scope.type}:${scope.refId} vanished after insert`);
  return owned(row);
}

/**
 * Whether this space still accepts writes — the lifecycle fence, and the ONLY thing
 * standing between a deleted project and a fact written into it.
 *
 * Post-turn extraction outlives its task on purpose (it runs once the reply is already
 * delivered), and project deletion reads task activity as "somebody is still working
 * here". So the task goes `completed`, the delete is allowed, and an auxiliary model
 * call that takes SECONDS returns into a space the user destroyed with a couple of
 * clicks in that same time. The fact then lives until the account itself is deleted.
 *
 * Checking before extraction starts would answer a question about a MOMENT; the window
 * opens right after it. So the check has to ride the write's own transaction, and it
 * has to be a LOCKING read:
 *
 *   - `retireProjectSpace` takes `FOR UPDATE` on this row as its first move. A writer
 *     that gets `FOR SHARE` first makes the retire wait, commits into a space that was
 *     still live, and the retire then deletes what it wrote — correct either way.
 *   - A writer that arrives second blocks here until the retire commits, and Postgres
 *     re-evaluates the `retired_at IS NULL` qualification on the updated row under
 *     READ COMMITTED. The row drops out of the result and the write refuses.
 *
 * A plain SELECT would take no lock, read `retired_at` from its own older snapshot and
 * write anyway — the same window, one statement narrower.
 *
 * The USER side needs none of this: `purgeUserSpaces` DELETEs the space row inside the
 * user's own delete transaction, so a late write either commits first and is taken by
 * the cascade, or arrives after and fails the foreign key. A project cannot borrow that
 * property — its space row has to survive deletion (a cited source version pins the
 * cascade, and `purgeUserSpaces` finds it later by `owner_user_id`), which is exactly
 * why the terminal state has to be a column somebody reads.
 *
 * Takes the caller's `ex` and nothing else: called outside the transaction that does
 * the write, it locks a row, releases it, and answers about the past.
 */
export async function spaceAcceptsWrites(spaceId: string, ex: Ex): Promise<boolean> {
  const [row] = await ex
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), isNull(spaces.retiredAt)))
    .limit(1)
    .for("share");
  return !!row;
}

/** The topic a fact lands in when nothing else chose one — as a KEY, which is what
 *  `vault_notes.topic_key` holds and what `getOrCreateTopicNote` resolves on.
 *
 *  This used to be `DEFAULT_TOPIC = "General"`, a string that was simultaneously the
 *  database key and the text on screen. Renaming it from one language to the other
 *  therefore forked every topic that already existed: the claims were re-attached under
 *  a second note, both notes stayed, and `topicCounts` printed both to the model on
 *  every turn — four facts asserted where two existed. Nine reviews read the constant
 *  and saw nothing, because it looks correct in each of its two roles separately.
 *
 *  Lowercase, ASCII, and never shown to anyone: a key that could pass for a label is
 *  how this comes back. */
export const DEFAULT_TOPIC_KEY = "general";

/** What the AGENT sees a topic called, by key. English on purpose and separate from
 *  `messages/*.json`: the manifest is prompt structure, not UI, and it must be
 *  byte-identical across turns regardless of the reader's locale — a manifest that
 *  changed language with a setting would break the prompt cache on every switch.
 *  A key with no entry falls back to the stored title, which is what a user-named
 *  topic (plan D2) will have. */
export const TOPIC_LABELS: Record<string, string> = { [DEFAULT_TOPIC_KEY]: "General" };

/** A topic title is destined for the manifest, which is a byte-budgeted tier, so it is
 *  bounded at the one place that renders it and at every writer that produces one. */
export const TOPIC_TITLE_MAX_CHARS = 64;

/** Single-line, whitespace-collapsed, clamped. Not `norm`: this is what a PERSON reads,
 *  so case and punctuation survive — `norm` answers "is this the same wording", which is
 *  a different question with a different frozenness requirement. */
export function fitTopicTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, TOPIC_TITLE_MAX_CHARS);
}

/** A memory topic is a note of kind `memory_topic`, identified by `topic_key`; the
 *  partial unique index on (space, key) is scoped to that kind, so it is the same race
 *  and the same resolution as `getOrCreateSpace`.
 *
 *  The stored `title` is a SEED for display, not the identity: it is written once, at
 *  creation, from the label table, and nothing reads it to find a row. That is what
 *  makes a rename control safe to build in plan D2 — it will write `title` and leave
 *  `topic_key` alone. */
export async function getOrCreateTopicNote(spaceId: string, topicKey: string, ex?: Ex): Promise<string> {
  // Two rows are written now, not one — the note and its node — so without a transaction
  // this stopped being a move and became a pair of autocommits: a crash between them
  // leaves a PERMANENT orphan node, which is the state `insertNode`'s missing `ex` default
  // exists to make unrepresentable. The `!ex || ex === db` shape is the one `createClaim`
  // documents: `Ex` permits passing the pool explicitly, and "omitted" and "explicit db"
  // must not mean different things.
  if (!ex || ex === db) return db.transaction((tx) => getOrCreateTopicNote(spaceId, topicKey, tx));

  // The FOURTH entrance into a space, and it is reachable: `migrateMemoryDocs` opens
  // the topic note BEFORE its first claim, so a bullet-less legacy document migrating
  // during the window between teardown's two transactions would commit an empty topic
  // into a retired space without ever meeting the claim fence. One empty note and no
  // user content is a small harm — but this feature's whole history is a guard standing
  // at one entrance of two, so it is closed rather than noted. The migration itself
  // does not rely on the throw: it checks and SKIPS, because a deleted project's
  // document is nothing to carry, not a failure to retry every boot.
  if (!(await spaceAcceptsWrites(spaceId, ex))) {
    throw new Error(`space ${spaceId} is retired; refusing to open a topic in it`);
  }
  const where = and(
    eq(vaultNotes.spaceId, spaceId),
    eq(vaultNotes.topicKey, topicKey),
    eq(vaultNotes.kind, "memory_topic"),
  );
  const found = await ex.select({ id: vaultNotes.id }).from(vaultNotes).where(where).limit(1);
  if (found[0]) return found[0].id;
  const noteId = nanoid();
  await insertNode({ id: noteId, spaceId, kind: "note" }, ex);
  const inserted = await ex
    .insert(vaultNotes)
    .values({ id: noteId, spaceId, topicKey, title: TOPIC_LABELS[topicKey] ?? topicKey, kind: "memory_topic" })
    .onConflictDoNothing()
    .returning({ id: vaultNotes.id });
  // The insert can be a no-op (a concurrent creator won the partial unique index), and
  // then the node row above belongs to a note that does not exist. Remove it rather than
  // leaving an orphan the graph would walk into: the loser of the race owns the cleanup,
  // because the winner cannot see what it displaced.
  if (!inserted.length) await ex.delete(vaultNodes).where(eq(vaultNodes.id, noteId));
  const [row] = await ex.select({ id: vaultNotes.id }).from(vaultNotes).where(where).limit(1);
  if (!row) throw new Error(`memory topic "${topicKey}" vanished after insert`);
  // The winner of the race projects; the loser projects the winner's row, which is a
  // no-op upsert on the same unit key. Both are correct and neither has to know which it
  // was - the alternative is a branch on a race, which is how one arm goes unexercised.
  await projectNoteDoc(row.id, ex);
  return row.id;
}

/** Deleting a project kills its MEMORY (claims, topics, candidates) but keeps its
 *  KNOWLEDGE: `chats.projectId` is SET NULL, so chats outlive the project and
 *  their citations still pin versions. Hence sources are soft-deleted and
 *  versions/fragments/citations are left alone. The space row also stays; purge
 *  by owner_user_id collects it (full GC is plan D).
 *
 *  Idempotent, because teardown is re-driven from the worker tick: exactly one
 *  `space.retire` event is written per space.
 *
 *  Leaves a row BEHIND IT EITHER WAY — see the tombstone below. "Retired" has to be
 *  something a later caller can read, and `ref_id` is polymorphic with no foreign key,
 *  so the absence of a row says nothing at all. */
export async function retireProjectSpace(projectId: string, ex?: Ex): Promise<void> {
  if (!ex) return db.transaction((tx) => retireProjectSpace(projectId, tx));

  const find = () =>
    ex
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

  let [space] = await find();
  if (!space) {
    // "There is no space" is NOT a terminal state, and treating it as one left this
    // whole mechanism open at the entrance that CREATES rather than writes. The fence
    // every writer takes (`spaceAcceptsWrites`) can only see a retirement that already
    // has a row to sit on, so a space created AFTER this ran — the boot migration
    // carrying a legacy `memory_docs` row for a project deleted a moment earlier, a
    // turn that resolved the project just before the delete committed — is born live,
    // passes every fence, and holds a deleted project's memory until the account
    // itself is deleted. So retirement writes the row it did not find: a tombstone the
    // polymorphic `ref_id` can always be looked up by, which the get-or-create then
    // hands back to those callers already closed.
    //
    // Both interleavings converge, because the unique index is what arbitrates: a
    // creator that got in first blocks this INSERT until it commits, and the re-read
    // below then finds its LIVE row and retires it (deleting whatever it wrote); a
    // creator that arrives after reads the tombstone and refuses.
    //
    // The owner comes from the project row — this is the one caller that knows the
    // polymorphic ref is a project id, and `owner_user_id` is what `purgeUserSpaces`
    // collects by, so a tombstone written under the wrong owner would outlive its
    // user. Guarded on the project actually being tombstoned: this function destroys
    // memory, and creating a retired space for a LIVE project would destroy it
    // permanently on a stray call. No project row at all means no tombstone is needed
    // — nothing can create a space for it any more (a memory doc cascades away with
    // the row, and a turn cannot resolve a deleted project).
    const [owner] = await ex
      .select({ userId: projects.userId })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNotNull(projects.deletedAt)))
      .limit(1);
    if (!owner) return;
    await ex
      .insert(spaces)
      .values({
        id: nanoid(),
        type: "project",
        refId: projectId,
        ownerUserId: owner.userId,
        retiredAt: new Date(),
      })
      .onConflictDoNothing();
    [space] = await find();
    if (!space) return;
  }
  const spaceId = space.id;

  // The terminal state, set BEFORE anything is removed and under the lock taken above:
  // a writer blocked on `spaceAcceptsWrites` re-reads this row the moment we commit,
  // and it must find the space already closed. Guarded on NULL so a re-drive from the
  // worker tick keeps the first retirement's timestamp — this is when the user deleted
  // the project, not when teardown last succeeded.
  await ex
    .update(spaces)
    .set({ retiredAt: new Date() })
    .where(and(eq(spaces.id, spaceId), isNull(spaces.retiredAt)));

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

  // Migration step 11.10, under Ruling 10. SOFT, and the softness is the whole finding:
  // this function hard-DELETEs claims and notes but SOFT-deletes sources, so a hard
  // `DELETE FROM vault_nodes WHERE space_id = ...` raises 23503 on
  // knowledge_source_node_fk against the source rows that deliberately survive — and
  // because `retired_at` is written at the top of this function and teardown is re-driven
  // from the worker tick, that abort would repeat forever with the space already closed to
  // writers and its memory never removed.
  //
  // It runs LAST of the removals so the node rows outlive the subtype rows within this
  // transaction. NOT because an FK requires that order — `deleteSpaceNodes` soft-deletes,
  // and no FK constrains the order of an UPDATE; the earlier wording here said it did and
  // was simply vacuous. The real reason is the end state: the source node finishes in the
  // same state as its source row, which is what made this correct rather than merely
  // working, and running it last is what keeps the two soft-deletes from disagreeing if a
  // later removal throws.
  const { nodes } = await deleteSpaceNodes(spaceId, ex);

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
      nodes,
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
 *  construction, so no separate retry path is needed.
 *
 *  ACCEPTED for plan A, and a PRIVACY BLOCKER for plan B (GPT audit #4): this removes
 *  the ROWS, not the content-addressed blobs a version points at. Plan A writes no
 *  blobs at all — the ingest in plan B is their only producer — so nothing is left
 *  behind today. The moment ingest lands, this function must reach the blob store
 *  too, or a deleted user's bytes stay on disk under a known SHA and the deletion is
 *  a lie. Recorded on the function that will be wrong, not in a plan document. */
export async function purgeUserSpaces(userId: string, ex: Ex = db): Promise<void> {
  await ex.delete(spaces).where(eq(spaces.ownerUserId, userId));
}
