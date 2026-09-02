import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { noteVersionEvidence, vaultNotes, vaultNoteVersions } from "@/lib/db/schema";
import { looksLikeSecret, type PromptAccess, type SourceClass } from "./claims";
import { horizonFor, type ServerClass } from "./grounding";
import { insertNode } from "./nodes";
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

/** `fitStatement`'s sibling, and the same three operations for the same reason: a note
 *  title is rendered into a byte-budgeted model tier and into the memory page's list, both
 *  of which are built for one line. 160 rather than 500 because a title is a label — the
 *  body is where the prose goes, and a title long enough to be prose is one that will be
 *  truncated by every surface that shows it anyway. */
export const NOTE_TITLE_MAX_CHARS = 160;

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

export function fitNoteTitle(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, NOTE_TITLE_MAX_CHARS);
}

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
 *  clause. This shape carries it so a caller holding a head (the `memory_open` reply in
 *  T12) can make the same decision the mints made, off the row it already has. */
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
 */
export async function insertNoteVersion(
  a: {
    noteId: string;
    revision: number;
    title: string;
    bodyMarkdown: string;
    sourceClass: ServerClass;
    sensitive?: boolean;
    provenance: Record<string, unknown>;
    createdTaskId?: string;
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
    sourceClass: ServerClass;
    sensitive?: boolean;
    provenance: Record<string, unknown>;
    createdTaskId?: string;
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
      revision: 1,
      title,
      bodyMarkdown,
      sourceClass: a.sourceClass,
      sensitive: a.sensitive,
      provenance: a.provenance,
      createdTaskId: a.createdTaskId,
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
    sourceClass: ServerClass;
    sensitive?: boolean;
    provenance: Record<string, unknown>;
    createdTaskId?: string;
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
      revision,
      title,
      bodyMarkdown,
      sourceClass: a.sourceClass,
      sensitive: a.sensitive,
      provenance: a.provenance,
      createdTaskId: a.createdTaskId,
    },
    ex,
  );
  await projectNoteDoc(a.noteId, ex);
  return { ok: true, revision, versionId: v.versionId };
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
