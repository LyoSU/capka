import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, noteVersionEvidence, vaultNodes, vaultNotes, vaultNoteVersions } from "@/lib/db/schema";
import { looksLikeSecret, type Actor, type PromptAccess, type SourceClass } from "./claims";
import { unlinkReferencesFrom } from "./edges";
import { carriedClass, horizonFor, type ServerClass } from "./grounding";
import { edgeTargets } from "./links";
import type { TopicSection } from "./memory-sections";
import { deleteNode, insertNode, restoreNode } from "./nodes";
import { fitNoteTitle } from "./note-title";
import { projectNoteDoc } from "./search-documents";
import { spaceAcceptsWrites, type Ex } from "./spaces";

/**
 * NOTE IDENTITY vs NOTE CONTENT, and the CAS between them.
 *
 * `vault_notes` is the stable identity, the topic container, and the home of the three
 * LIFECYCLE columns (`expires_at`, `retired_at`, `last_used_at`). `vault_note_versions`
 * is immutable content. A write is a compare-and-swap in one transaction: read
 * `current_revision`, verify it equals the caller's `expected_revision`, insert the new
 * version, then `UPDATE ... WHERE current_revision = $expected`, and abort on zero rows.
 * (`cas.ts` is CAS for BLOBS, not for rows; the note CAS lives with the note writer.)
 *
 * A NEW REVISION RE-ARMS THE HORIZON FROM ITS OWN CLASS and never inherits the old one
 * (§12): a note that started as the person's words and was later rewritten by the agent
 * is agent content from that revision on, and its retention has to say so.
 *
 * THE INVERSE lives in `nodes.ts`: a note's versions cascade from the note row, and the
 * note NODE's soft delete is what removes it from every list and from the graph.
 *
 * `horizonFor` is imported from `grounding.ts` and NOT redefined here (Ruling 13): it is
 * keyed on the class, the class has exactly one producer, and a second copy beside the
 * note writers would be the same rule at two entrances — with the added cost of an import
 * out of `claims.ts` this module does not otherwise need.
 *
 * EVERY NOTE HAS A REVISION 1, and that is a property of the module rather than of a
 * count. There are exactly two writers of a `vault_notes` row in `src/` — `createNote`
 * below and `resolveTopic`'s creation arm in `topics.ts` — and both reach revision 1
 * through `insertNoteVersion`, which is the only writer of a `vault_note_versions` row.
 * That matters beyond tidiness: `0065`'s backfill is a ONE-SHOT guard, so a note created
 * without a version after it ran can never be re-checked by anything.
 */

/** The title bound and its clamp are RE-EXPORTED, not defined here: they moved to the
 *  import-free `note-title.ts` so `links.ts` could stop importing this module. Existing
 *  callers keep their import path; see that file for why the cycle was worth removing
 *  while it was still benign. */
export { NOTE_TITLE_MAX_CHARS, fitNoteTitle } from "./note-title";

/**
 * WHAT ONE TOOL CALL MAY WRITE INTO A BODY, as a schema bound rather than a clamp.
 *
 * A note body is the one kind of stored text this system means to be long, so there is no
 * `fitStatement` for it — but "long" is not "unbounded". The vault's turn budget bounds what
 * a tool HANDS BACK and says nothing about what a tool STORES, and the stored bytes are
 * re-read on every later `memory_open` and re-indexed on every revision.
 *
 * A bound on the SCHEMA rather than a truncation in the writer, because truncating a note
 * mid-sentence and reporting success is worse than refusing the call: the provider corrects
 * a schema violation before a database is touched, and the model still has a next step in
 * which to split the note in two.
 *
 * §4.6 states no bound of its own; these are this implementation's, and the pair is chosen so
 * the worst case (40,000 characters) stays a handful of `MEMORY_OPEN_MAX_BYTES` pages rather
 * than an unpaginable wall.
 */
export const NOTE_BLOCK_MAX_CHARS = 2_000;
export const NOTE_BLOCKS_MAX = 20;

/** Which heading the owner's memory page lists a note under. Re-exported from the module
 *  that OWNS the four values rather than restated here — see `memory-sections.ts` for why
 *  that module has no imports and why the schema's copy is the one that stays literal. */
export type NoteSection = TopicSection;

/**
 * A BODY, or a function that computes one from the note's OWN id.
 *
 * The callback exists for exactly one caller shape and it is the one §4.6 and §4.8 fix the
 * write order for: a body carrying canonical edge tokens cannot be known before the note
 * exists, because a `references` edge needs its FROM-node — this note — to be a row already.
 * So the order inside both writers is node -> note shell -> (the caller creates its edges
 * here) -> serialize -> version, and this parameter is where the middle step lands.
 *
 * It runs INSIDE the writer's transaction, after the row that makes an edge legal and before
 * the version that names one. A caller doing the same thing by hand would be a third writer
 * of a `vault_notes` row, which is the count `insertNoteVersion` exists to keep at two.
 */
export type NoteBody = string | ((noteId: string) => Promise<string>);

/** The compatibility column is dual-written with the version body, so a computed body has to
 *  land on it too — one extra statement, and only on the callback path. It is not folded into
 *  the CAS or the shell insert because the value does not exist yet at either. */
async function resolveBody(body: NoteBody, noteId: string, ex: Ex): Promise<string> {
  if (typeof body === "string") return body;
  const resolved = await body(noteId);
  await ex.update(vaultNotes).set({ body: resolved }).where(eq(vaultNotes.id, noteId));
  return resolved;
}

/** A note as a reader that is about to DECIDE something needs it: the head version's
 *  content and class, the identity's lifecycle, and the channel the version generated.
 *
 *  `promptAccess` is read and never selected on here — `model-view.ts` owns every channel
 *  clause. It is on this shape so a caller that already holds a head can REPORT the channel
 *  the database put the row on: `memory_note_write` reads it back onto its return, exactly as
 *  `factWrite` reads `findCurrentHead`'s.
 *
 *  It is NOT what `memory_open` switches on, which is what an earlier draft of this line
 *  said. That decision lives inside `openNoteForModel`, because §3.4's NEW-3 requires
 *  `memory_open`'s text to come from the mint for the row's channel — so the mint is what
 *  refuses an off-channel row, and a channel check written against this field in the tool
 *  would be a second answer to the same question. */
export type NoteHead = {
  id: string;
  spaceId: string;
  revision: number;
  versionId: string;
  title: string;
  bodyMarkdown: string;
  sourceClass: SourceClass;
  sensitive: boolean;
  promptAccess: PromptAccess;
  staleSince: Date | null;
};

/**
 * THE writer of a `vault_note_versions` row, and the second and third statements of both
 * note writers: insert the content, then point the note at it.
 *
 * It takes an `ex` with no default, exactly like `insertNode`: a version row is content of
 * a note that already exists in somebody else's transaction, and there is no such thing as
 * writing one alone.
 *
 * THE SECRET SCREEN IS APPLIED HERE rather than at each caller — the same three-column
 * rule `vault_claims`' two writers hold, on the same grounds: a note body is model-facing
 * text and a credential in it would ride `memory_search`. Single-homing it is what lets
 * `createNote` RETURN the effective value instead of the one it was asked for.
 *
 * The pointer UPDATE carries `current_revision = revision`. In `createNote` that is the
 * revision the note row was just inserted with; in `reviseNote` it is what statement 1
 * swapped to. It is DEFENCE IN DEPTH rather than a race it prevents — statement 1 holds
 * the row's write lock until commit — and it covers the one shape the transaction wrapper
 * cannot see: a caller passing an OUTER transaction that has already released the row.
 *
 * The caller CLAMPS the title (`fitNoteTitle`, or `fitTopicTitle` for a topic). This
 * function must not re-clamp: the version title has to equal `vault_notes.title` byte for
 * byte, because `projectNoteDoc` indexes one and `topicRows` renders the other.
 *
 * §2.11's `note.revise` IS WRITTEN HERE, at the one implementation, for the reason the
 * paragraph above gives about revision 1: three callers, one implementation, one grep. It
 * is what the chat's "saved to memory" notice projects over, and putting it in the two
 * note WRITERS instead would leave a fourth writer silently unannounced.
 *
 * A topic container reaches this function too and is deliberately NOT excluded here: the
 * event says a version was written, which is true of a topic's revision 1 as well, and
 * the notice's own predicate is `provenance->>'messageId'` — which `resolveTopic` does not
 * set, because no turn "wrote" the General topic. A `kind` check in this function would be
 * a second answer to a question the provenance already answers.
 */
export async function insertNoteVersion(
  a: {
    noteId: string;
    /** The note's space. It is a parameter rather than a read because both writers already
     *  hold it and `audit_events.space_id` is NOT NULL — and because a read here would be
     *  a fourth statement in a move whose whole point is being three. */
    spaceId: string;
    revision: number;
    title: string;
    bodyMarkdown: string;
    sourceClass: ServerClass;
    sensitive?: boolean;
    provenance: Record<string, unknown>;
    createdTaskId?: string;
    /** Who wrote this revision. `system` is the honest default for a topic container that
     *  no turn asked for; the note writers pass the turn's own actor. */
    actor?: Actor;
  },
  ex: Ex,
): Promise<{ versionId: string; sensitive: boolean }> {
  const versionId = nanoid();
  const sensitive = a.sensitive || looksLikeSecret(a.title) || looksLikeSecret(a.bodyMarkdown);
  await ex.insert(vaultNoteVersions).values({
    id: versionId,
    noteId: a.noteId,
    revision: a.revision,
    title: a.title,
    bodyMarkdown: a.bodyMarkdown,
    sourceClass: a.sourceClass,
    sensitive,
    provenance: a.provenance,
    createdTaskId: a.createdTaskId ?? null,
  });
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: a.spaceId,
    actor: a.actor ?? { kind: "system" },
    action: "note.revise",
    subjectType: "note",
    subjectId: a.noteId,
    // No title and no body: the audit log is read more widely than the space itself, and
    // `retireProjectSpace` keeps these events after deleting the notes — so whatever rides
    // here outlives the user's own deletion of the project. The revision addresses which
    // version, and the row itself holds the words for as long as it exists.
    payload: { revision: a.revision, versionId },
  });
  await ex
    .update(vaultNotes)
    .set({ currentVersionId: versionId })
    .where(and(eq(vaultNotes.id, a.noteId), eq(vaultNotes.currentRevision, a.revision)));
  return { versionId, sensitive };
}

/**
 * A note and its revision 1, in one move.
 *
 * FIVE statements, so without a transaction this is not a move. See the module docstring
 * and `insertNode`'s: a crash between the node insert and the note insert leaves a
 * permanent orphan node, which is the state `insertNode`'s missing `ex` default exists to
 * make unrepresentable. `ex` is optional and the wrapper opens its own transaction when it
 * is omitted OR is the pool — "omitted" and "explicit db" must not mean different things,
 * which is the shape `createClaim` and `resolveTopic` already document.
 *
 * The statement ORDER is the same one `reviseNote` explains at length: node → note (with
 * the pointer NULL) → version → `UPDATE … SET current_version_id`. `current_version_id`'s
 * FK is a plain `references()`, not DEFERRABLE, so naming a version before its INSERT
 * raises 23503 at the statement. That is why the column is nullable forever and why
 * head-ness compares integers instead (Ruling 4): every legal writer passes through a
 * moment where the pointer is NULL.
 */
export async function createNote(
  a: {
    spaceId: string;
    title: string;
    bodyMarkdown: NoteBody;
    kind?: "note" | "memory_topic" | "index";
    topicKey?: string | null;
    /** Which heading the owner's memory page lists this file under. Omitted is `'topic'`,
     *  by the column's own default — see `vault_notes.section`. It is a SHELF and nothing
     *  else: no model-facing read looks at it and it grants no authority, which is why it
     *  sits beside `kind` here rather than anywhere near `sourceClass`. */
    section?: NoteSection;
    sourceClass: ServerClass;
    sensitive?: boolean;
    provenance: Record<string, unknown>;
    createdTaskId?: string;
    /** Who is writing. It reaches `audit_events` and nothing else — the note's own trust
     *  is `source_class`, and an actor cannot raise it. */
    actor?: Actor;
  },
  ex?: Ex,
): Promise<{ id: string; revision: number; versionId: string; sensitive: boolean }> {
  if (!ex || ex === db) return db.transaction((tx) => createNote(a, tx));
  if (!(await spaceAcceptsWrites(a.spaceId, ex))) {
    throw new Error(`space ${a.spaceId} is retired; refusing to write a note into it`);
  }
  const id = nanoid();
  const title = fitNoteTitle(a.title);
  await insertNode({ id, spaceId: a.spaceId, kind: "note" }, ex);
  await ex.insert(vaultNotes).values({
    id,
    spaceId: a.spaceId,
    // The two compatibility columns, dual-written: `title` is what `topicRows` groups on
    // and what `uniq_vnotes_topic_title` folds, and `body` is what the memory page and the
    // export still read. The head version is authoritative for content from here on.
    title,
    body: typeof a.bodyMarkdown === "string" ? a.bodyMarkdown : "",
    kind: a.kind ?? "note",
    topicKey: a.topicKey ?? null,
    // Omitted leaves the column's `'topic'` default in place rather than writing it here:
    // one default, in the schema, where the CHECK that bounds it also lives.
    ...(a.section ? { section: a.section } : {}),
    currentRevision: 1,
    // Armed at insert, by the writer, from the class this note is about to store — never
    // by a trigger and never by a backfill (§4.5 step 8).
    expiresAt: horizonFor(a.sourceClass),
  });
  // The caller's edges are created HERE, between the row that makes one legal and the
  // version that names one. See `NoteBody`.
  const bodyMarkdown = await resolveBody(a.bodyMarkdown, id, ex);
  const v = await insertNoteVersion(
    {
      noteId: id,
      spaceId: a.spaceId,
      revision: 1,
      title,
      bodyMarkdown,
      sourceClass: a.sourceClass,
      sensitive: a.sensitive,
      provenance: a.provenance,
      createdTaskId: a.createdTaskId,
      actor: a.actor,
    },
    ex,
  );
  await projectNoteDoc(id, ex);
  return { id, revision: 1, versionId: v.versionId, sensitive: v.sensitive };
}

/**
 * A new revision of an existing note, as a compare-and-swap on `current_revision`.
 *
 * THREE STATEMENTS, IN THIS ORDER, AND THE ORDER IS THE FIX (Ruling 17).
 *
 * The obvious shape — one UPDATE setting `current_revision` AND `current_version_id`, then
 * the version insert — raises 23503 on EVERY revision: `current_version_id`'s FK is a
 * plain `references()`, not DEFERRABLE INITIALLY DEFERRED, so naming a version row before
 * it exists is a foreign-key violation at the statement, not at commit.
 *
 *   1. CAS on `current_revision` ALONE. One statement takes the row lock, checks the
 *      revision and checks the space, so there is no window between checking and writing —
 *      the same shape `updateClaim`'s CAS uses. The horizon is re-armed here, from the
 *      INCOMING class, never inherited.
 *   2. Insert the version. A CAS loser never reaches this, and a concurrent winner at the
 *      same revision is refused by `uniq_vnote_versions_rev` — so splitting the write costs
 *      no orphan, which is what the single-statement form was buying.
 *   3. Point the note at it. Statements 2 and 3 are `insertNoteVersion`, which is where the
 *      `current_revision = $revision` guard on the pointer is explained.
 *
 * A LOST CAS WRITES NOTHING and says what the current head is, so a caller can re-read and
 * re-propose rather than guess. It is not an exception: losing a race is an ordinary
 * outcome of a concurrent edit, and the reply carries the two things needed to recover.
 */
export async function reviseNote(
  a: {
    noteId: string;
    spaceId: string;
    expectedRevision: number;
    title: string;
    bodyMarkdown: NoteBody;
    /** A NEW shelf for this file, when the write names one. OMITTED LEAVES IT WHERE IT IS,
     *  which is the whole reason this is optional rather than defaulted: `section` lives on
     *  the note IDENTITY and not on a revision, so a rewrite that says nothing about the
     *  shelf must not silently move the file back to `'topic'` — a person would watch their
     *  own filing undo itself every time the agent updated the text. */
    section?: NoteSection;
    sourceClass: ServerClass;
    sensitive?: boolean;
    provenance: Record<string, unknown>;
    createdTaskId?: string;
    /** Who is writing — see `createNote`. */
    actor?: Actor;
  },
  ex?: Ex,
): Promise<
  { ok: true; revision: number; versionId: string } | { ok: false; currentRevision: number; currentTitle: string }
> {
  if (!ex || ex === db) return db.transaction((tx) => reviseNote(a, tx));
  if (!(await spaceAcceptsWrites(a.spaceId, ex))) {
    throw new Error(`space ${a.spaceId} is retired; refusing to revise a note in it`);
  }
  const revision = a.expectedRevision + 1;
  const title = fitNoteTitle(a.title);

  const [won] = await ex
    .update(vaultNotes)
    .set({
      currentRevision: revision,
      title,
      body: typeof a.bodyMarkdown === "string" ? a.bodyMarkdown : "",
      updatedAt: new Date(),
      expiresAt: horizonFor(a.sourceClass),
      ...(a.section ? { section: a.section } : {}),
    })
    .where(
      and(
        eq(vaultNotes.id, a.noteId),
        eq(vaultNotes.spaceId, a.spaceId),
        eq(vaultNotes.currentRevision, a.expectedRevision),
      ),
    )
    .returning({ id: vaultNotes.id });
  if (!won) {
    const [cur] = await ex
      .select({ revision: vaultNotes.currentRevision, title: vaultNotes.title })
      .from(vaultNotes)
      .where(and(eq(vaultNotes.id, a.noteId), eq(vaultNotes.spaceId, a.spaceId)))
      .limit(1);
    return { ok: false, currentRevision: cur?.revision ?? 0, currentTitle: cur?.title ?? "" };
  }
  // AFTER the CAS, never before it: a lost CAS must write nothing at all, and the caller's
  // callback is where its `references` edges are created (§4.8). See `NoteBody`.
  const bodyMarkdown = await resolveBody(a.bodyMarkdown, a.noteId, ex);
  const v = await insertNoteVersion(
    {
      noteId: a.noteId,
      spaceId: a.spaceId,
      revision,
      title,
      bodyMarkdown,
      sourceClass: a.sourceClass,
      sensitive: a.sensitive,
      provenance: a.provenance,
      createdTaskId: a.createdTaskId,
      actor: a.actor,
    },
    ex,
  );
  await projectNoteDoc(a.noteId, ex);
  return { ok: true, revision, versionId: v.versionId };
}

/**
 * THE OWNER'S UNDO OF AN EDIT — the note's own earlier words as a NEW revision.
 *
 * IT IS NOT A DELETE, and that distinction is the whole reason it exists. The chat's notice
 * offers Undo on everything a turn wrote to memory, and a turn that merely EDITED an
 * existing file was answered with `forgetNote`: the file went, with all its revisions, off
 * every list — for a person who asked only to leave the file as it was. "Saved N things"
 * with an Undo beside each is a promise about the turn's writes, not a licence to remove
 * what the turn found already there.
 *
 * IT IS NOT A ROLLBACK EITHER. History is append-only here (§4.6), so putting revision N−1
 * back means writing revision N+1 with those words, through `reviseNote`'s CAS like every
 * other write — the edit stays in the record, and so does the undo. A person can therefore
 * revert a revert. The record is `vault_note_versions`, and it is a record and not yet a
 * SURFACE: nothing renders a note's version history in this slice. `topicsOf` projects the
 * head alone, and the memory page's `showHistory` is the FACT row's superseded chain, which
 * is a different object. So an undo is currently explained by the words changing back and
 * by nothing else; a reader for the chain is slice-4 work.
 *
 * THE CLASS IS CARRIED, NEVER RE-DECIDED — see `carriedClass` for why both alternatives are
 * worse. Same for `sensitive`: the words are the old words, so their flag is the old flag,
 * and `insertNoteVersion`'s screen still runs over them on the way in.
 *
 * THE LINKS THE OLD BODY DOES NOT MENTION ARE CLOSED, in the same transaction, because §4.8
 * is symmetric: an edge that outlives its token renders a link the body does not make. That
 * is the `memory_link` case and the common one — the link block goes and its `references`
 * edge closes with it. A token in the restored body whose edge some LATER revision closed
 * stays closed and renders as removed-link text: reopening it would be this function
 * deciding to restore a relationship a different write removed.
 *
 * `not_revertable` when `toRevision` is not strictly below the head: reverting to the head
 * is a no-op dressed as a write, and reverting FORWARD is not a thing an undo can mean.
 *
 * `revision_moved` when the caller named an `expectedRevision` that is not the head, or
 * when the CAS below loses to a concurrent write. Those two are ONE answer on purpose:
 * both mean the file is not what the caller was looking at, and the only useful next step
 * is the same one — say so and let the person look again.
 */
export async function revertNote(
  a: {
    noteId: string;
    spaceId: string;
    toRevision: number;
    /** THE HEAD THE CALLER WAS LOOKING AT, when the caller was looking at one. The chat
     *  notice computes `toRevision` from a revision it rendered, and between that render
     *  and the click a later turn may have edited the same file: without this, the revert
     *  succeeds and silently drops that later edit out of the head, for a person who has no
     *  version-history surface to notice it with. Optional because a caller that read the
     *  head itself a statement ago has nothing stale to guard against. */
    expectedRevision?: number;
    actor: Actor;
  },
  ex?: Ex,
): Promise<
  | { ok: true; revision: number }
  | { ok: false; reason: "not_found" | "not_revertable" }
  /** THE HEAD AS OF THE REFUSAL, and on both arms it is a value this transaction has just
   *  read — never the one the caller sent. A stale `expectedRevision` is answered with the
   *  head this function read; a lost CAS is answered with the head `reviseNote` re-read
   *  after losing, which is strictly newer than the one this function started from. The
   *  caller's next move is to tell somebody what the revision is NOW, and naming the number
   *  they already believe is current answers nothing. */
  | { ok: false; reason: "revision_moved"; revision: number }
> {
  if (!ex || ex === db) return db.transaction((tx) => revertNote(a, tx));

  const head = await noteHead(a.noteId, [a.spaceId], ex);
  // One answer for "no such note", "not in this space" and "deleted since": `noteHead`
  // joins the node's tombstone, so a forgotten note is absent here rather than revertable.
  if (!head) return { ok: false, reason: "not_found" };
  // BEFORE the revertability check, and before anything is read or written: a stale caller
  // asking about a head that has moved is answered with what the head IS, not with a verdict
  // computed against a revision it does not know about.
  if (a.expectedRevision !== undefined && a.expectedRevision !== head.revision) {
    return { ok: false, reason: "revision_moved", revision: head.revision };
  }
  if (a.toRevision < 1 || a.toRevision >= head.revision) return { ok: false, reason: "not_revertable" };

  const [target] = await ex
    .select({
      title: vaultNoteVersions.title,
      bodyMarkdown: vaultNoteVersions.bodyMarkdown,
      sourceClass: vaultNoteVersions.sourceClass,
      sensitive: vaultNoteVersions.sensitive,
    })
    .from(vaultNoteVersions)
    .where(and(eq(vaultNoteVersions.noteId, a.noteId), eq(vaultNoteVersions.revision, a.toRevision)))
    .limit(1);
  if (!target) return { ok: false, reason: "not_found" };

  const upd = await reviseNote(
    {
      noteId: a.noteId,
      spaceId: a.spaceId,
      expectedRevision: head.revision,
      title: target.title,
      // AFTER the CAS, which is what the callback shape buys: a lost race must close no
      // edges. `edgeTargets` reads the LIVE edges the restored body names, and everything
      // else this note references is a link the restored body does not make.
      bodyMarkdown: async (noteId) => {
        const keep = await edgeTargets(target.bodyMarkdown, a.spaceId, ex);
        await unlinkReferencesFrom(noteId, a.spaceId, [...keep.values()].map((t) => t.nodeId), ex);
        return target.bodyMarkdown;
      },
      sourceClass: carriedClass(target.sourceClass),
      sensitive: target.sensitive,
      // WHERE THIS REVISION CAME FROM, in the shape every other provenance takes: no
      // `messageId` and no `taskId`, because no turn wrote it — which is also what keeps
      // `readTurnWrites` from naming an undo as something the turn saved.
      provenance: { kind: "revert", of: head.revision, to: a.toRevision },
      actor: a.actor,
    },
    ex,
  );
  // The head moved between the read and the CAS — another tab, or the agent mid-turn. The
  // person can look and ask again; silently reverting whatever is there now would undo an
  // edit they have not seen.
  //
  // THE REVISION REPORTED IS `reviseNote`'s, not the one read at the top of this function.
  // A losing CAS re-reads the row before it returns, so the newer value is already in hand
  // at no cost — while `head.revision` is, on the guarded path, exactly the number the
  // caller sent as `expectedRevision`. Reporting that would answer "the file moved" and
  // then name the revision the client already believes is current, which is not an answer.
  //
  // A ZERO IS NOT A REVISION. `reviseNote` reports `0` when its post-CAS re-read finds no
  // row at all, which here means the note was deleted while this transaction was running —
  // a concurrent wipe of the space's memory is the only way in. Passing that on would send
  // the chat notice `409 { revision: 0 }`, a number the person can neither see nor retry
  // with, so it becomes the answer the caller already knows how to handle: the file is gone.
  if (!upd.ok && upd.currentRevision < 1) return { ok: false, reason: "not_found" };
  if (!upd.ok) return { ok: false, reason: "revision_moved", revision: upd.currentRevision };
  return { ok: true, revision: upd.revision };
}

/**
 * One note's head, scoped to spaces the caller is allowed to read.
 *
 * HEAD-NESS IS `revision = current_revision`, not the id pointer, for the reason
 * `vault_notes.current_version_id`'s own docstring gives: the pointer is legitimately NULL
 * for a statement or two inside both writers, and a reader that joined on it would answer
 * "no such note" for a note that exists.
 *
 * It takes `allowedSpaceIds` rather than one space so a caller holding a user space and a
 * project space can resolve a handle without deciding which one it belongs to first —
 * and so that a note id from OUTSIDE that list resolves to `null` rather than to a row.
 */
export async function noteHead(
  noteId: string,
  allowedSpaceIds: string[],
  ex: Ex = db,
): Promise<NoteHead | null> {
  if (!allowedSpaceIds.length) return null;
  const [row] = await ex
    .select({
      id: vaultNotes.id,
      spaceId: vaultNotes.spaceId,
      revision: vaultNotes.currentRevision,
      versionId: vaultNoteVersions.id,
      title: vaultNoteVersions.title,
      bodyMarkdown: vaultNoteVersions.bodyMarkdown,
      sourceClass: vaultNoteVersions.sourceClass,
      sensitive: vaultNoteVersions.sensitive,
      promptAccess: vaultNoteVersions.promptAccess,
      staleSince: vaultNoteVersions.staleSince,
    })
    .from(vaultNotes)
    .innerJoin(
      vaultNoteVersions,
      and(eq(vaultNoteVersions.noteId, vaultNotes.id), eq(vaultNoteVersions.revision, vaultNotes.currentRevision)),
    )
    .where(and(eq(vaultNotes.id, noteId), inArray(vaultNotes.spaceId, allowedSpaceIds)))
    .limit(1);
  return row ?? null;
}

/**
 * The note-side `claim_evidence` writer: what a revision was built from.
 *
 * `ex` is REQUIRED and there is no wrapper, unlike the two writers above. Evidence is
 * recorded for a version that the same transaction just inserted — a row attached to a
 * revision that ended up rolled back would be evidence for content nobody ever stored, and
 * the FK's `on delete cascade` cleans up only the case where the version row itself goes.
 *
 * The quote snapshot is taken by the CALLER, from `knowledge_fragments.model_text` and
 * never from `text` — that rule belongs to slice 3's ingest, which is the first thing with
 * a fragment to snapshot. This function is the row writer, not the policy.
 */
export async function attachNoteEvidence(
  versionId: string,
  ev: {
    blockOrdinal: number;
    fragmentId?: string | null;
    messageId?: string | null;
    quoteSnapshot?: string | null;
    locatorSnapshot?: unknown;
    relation?: "supports" | "refutes" | "derived_from";
  },
  ex: Ex,
): Promise<void> {
  await ex.insert(noteVersionEvidence).values({
    id: nanoid(),
    noteVersionId: versionId,
    blockOrdinal: ev.blockOrdinal,
    fragmentId: ev.fragmentId ?? null,
    messageId: ev.messageId ?? null,
    quoteSnapshot: ev.quoteSnapshot ?? null,
    locatorSnapshot: ev.locatorSnapshot ?? null,
    relation: ev.relation ?? "supports",
  });
}

/**
 * A NOTE'S SOFT DELETE — bounded to the task that wrote its head version for the AGENT
 * (§4.9), and unbounded for the OWNER.
 *
 * THE BOUND IS A COLUMN COMPARISON INSIDE THE WRITE, exactly as it is for a claim — and for a
 * note that column is on the HEAD VERSION rather than on the identity: `vault_notes` carries
 * no `created_task_id`, and it should not grow one, because "who wrote this" is a property of
 * a revision. So the condition is an `EXISTS` over `vault_note_versions` at
 * `revision = current_revision`, handed to `deleteNode` as the extra clause on ITS statement.
 * Reachability is not authority, and a rule enforced at one entrance grows a second.
 *
 * `createdTaskId` IS OPTIONAL, and its absence is the owner's undo — the same shape
 * `forgetClaim.requireCreatedTaskId` already has, for the same reason. The same-task bound
 * is the AGENT's limit: it exists because a model holding a handle has not thereby shown
 * that the person asked. A request from the person's own session has shown exactly that, by
 * the session, and it carries no words at all — so there is nothing for a fetched page to
 * have supplied. Widening the bound would be wrong; having no bound on the owner's path is
 * what the bound was always narrower than.
 *
 * IT GOES THROUGH `deleteNode`, not around it: the node's tombstone and the cascade of its
 * live edges are one act, and this module does not own that pair. What this function owns is
 * the note-shaped question — which revision is the head, and who wrote it.
 *
 * The three outcomes the tool needs are distinguished HERE and not in the statement: the
 * statement can only say "nothing matched", and a caller that reported that as one thing
 * would tell a person their own note is un-deletable when they simply held a stale revision.
 */
export async function forgetNote(
  a: {
    noteId: string;
    spaceId: string;
    expectedRevision: number;
    /** Present for the AGENT's `memory_forget`; absent for the owner's own delete. */
    createdTaskId?: string;
    actor: Actor;
  },
  ex?: Ex,
): Promise<
  { ok: true } | { ok: false; reason: "not_found" | "revision_mismatch" | "not_this_task"; revision: number | null }
> {
  if (!ex || ex === db) return db.transaction((tx) => forgetNote(a, tx));

  // The head-ness half of the clause is UNCONDITIONAL and the task half is not. Folding
  // both away for the owner would drop the `revision = current_revision` check with the
  // bound, so an owner's stale page could delete a note by naming a revision that is no
  // longer the head — which is a different rule, and one nobody meant to relax.
  const createdTaskId = a.createdTaskId;
  const deleted = await deleteNode(a.noteId, a.spaceId, ex, {
    onlyIf: sql`exists (
      select 1 from ${vaultNoteVersions} v
       where v.note_id = ${a.noteId}
         and v.revision = ${a.expectedRevision}
         and v.revision = (select n.current_revision from ${vaultNotes} n where n.id = ${a.noteId})
         ${createdTaskId ? sql`and v.created_task_id = ${createdTaskId}` : sql``})`,
  });
  if (!deleted) {
    // WHY it matched nothing, read back after the fact. The order is the order the model can
    // act on: a revision it can re-read beats a bound it cannot cross.
    const head = await noteHead(a.noteId, [a.spaceId], ex);
    if (!head) return { ok: false, reason: "not_found", revision: null };
    if (head.revision !== a.expectedRevision) {
      return { ok: false, reason: "revision_mismatch", revision: head.revision };
    }
    return { ok: false, reason: "not_this_task", revision: head.revision };
  }

  // §2.11's `node.delete`, and the owner's own delete gets one too when slice 4 builds it
  // (L9): an owner action with no audit row is the thing this feature has been asked about
  // most. No text in the payload — the audit log is read more widely than the space itself.
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: a.spaceId,
    actor: a.actor,
    action: "node.delete",
    subjectType: "note",
    subjectId: a.noteId,
    payload: { revision: a.expectedRevision, createdTaskId: a.createdTaskId ?? null },
  });
  return { ok: true };
}

/**
 * THE OWNER'S UNDO of `forgetNote` — the note back on the page, filed as it was.
 *
 * IT EXISTS BECAUSE THE DELETE HAS NO CONFIRMATION. The memory page removes a topic file on
 * one click and offers Undo in a toast, which is the T16 pattern moved one surface over: a
 * modal in front of every delete makes the frequent, correct case tedious to defend against
 * the rare mis-click, while an undo makes the mis-click free. That trade is only honest if
 * the undo genuinely restores, so this is a real inverse and not a second delete with a
 * friendlier name.
 *
 * NO TASK BOUND AND NO ACTOR CHOICE: this is the owner's own path, exactly like
 * `forgetNote` without a `createdTaskId`, and there is no agent equivalent. `memory_forget`
 * has no undo tool beside it and must not grow one — a model that could put back what the
 * person just removed would make the person's delete a suggestion.
 *
 * THE FACTS COME BACK WITH IT AND NEED NOTHING DONE: `deleteNode` leaves `note_claims`
 * alone ("forgetting a fact does not mean rewriting where it came from"), and the page reads
 * the filing from that table — so the topic's Related facts list is intact the moment the
 * node is live again. `restoreNode` reopens the `contains` EDGES, which the page does not
 * read but `containsParity` does; see its docstring for why that is not optional.
 *
 * `not_found` covers three things on purpose — no such note, not in this space, and not
 * deleted at all. The third is the interesting one and it is still not an error: an undo
 * clicked twice, or in two tabs, means the person wants the note back, and it is back.
 */
export async function restoreNote(
  a: { noteId: string; spaceId: string; actor: Actor },
  ex?: Ex,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  if (!ex || ex === db) return db.transaction((tx) => restoreNote(a, tx));

  // The stamp `deleteNode` wrote, which is what scopes the edge half of the restore. Read
  // inside the transaction that is about to clear it, so the value cannot belong to a
  // different delete than the one being undone.
  const [tomb] = await ex
    .select({ deletedAt: vaultNodes.deletedAt })
    .from(vaultNodes)
    .where(and(eq(vaultNodes.id, a.noteId), eq(vaultNodes.spaceId, a.spaceId), isNotNull(vaultNodes.deletedAt)))
    .limit(1);
  if (!tomb?.deletedAt) return { ok: false, reason: "not_found" };
  if (!(await restoreNode(a.noteId, a.spaceId, tomb.deletedAt, ex))) return { ok: false, reason: "not_found" };

  // The projection, by the module that owns the note side of it — see `restoreNode` for why
  // this half is the caller's. Without it the note is on the page and invisible to
  // `memory_search` for the rest of its life.
  await projectNoteDoc(a.noteId, ex);
  const [head] = await ex
    .select({ revision: vaultNotes.currentRevision })
    .from(vaultNotes)
    .where(eq(vaultNotes.id, a.noteId))
    .limit(1);
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: a.spaceId,
    actor: a.actor,
    action: "node.restore",
    subjectType: "note",
    subjectId: a.noteId,
    // No title and no body, the same rule `insertNoteVersion`'s event states: the audit log
    // outlives the space's own content.
    payload: { revision: head?.revision ?? null },
  });
  return { ok: true };
}
