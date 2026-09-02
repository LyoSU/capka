import { and, eq, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { vaultNodes, vaultNotes } from "@/lib/db/schema";
import { looksLikeSecret } from "./claims";
import { ownerAuthored } from "./grounding";
import { HANDLE_RE, type HandleTarget } from "./handles";
import { insertNode, restoreNode } from "./nodes";
import { insertNoteVersion } from "./notes";
import { projectNoteDoc } from "./search-documents";
import { spaceAcceptsWrites, type Ex } from "./spaces";

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
 *  a different question with a different frozenness requirement.
 *
 *  `\s` here is deliberate and is not the class `topicTitleNorm` refuses. This function
 *  runs FIRST, on what a person typed, and its job is display: a non-breaking space in a
 *  pasted title becomes an ordinary space here, before either half of the frozen twin ever
 *  sees it. That is what makes the ASCII-only class downstream sufficient rather than
 *  merely narrower — the divergence it protects against has already been normalized away.
 *  If this line ever stops running before the fold, the twin's argument stops holding. */
export function fitTopicTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, TOPIC_TITLE_MAX_CHARS);
}

/**
 * TOPIC IDENTITY, and the one producer of it.
 *
 * Lives here rather than in `spaces.ts` because the resolver needs `looksLikeSecret` from
 * `claims.ts`, which already imports `spaces.ts` — leaving it there would be a runtime
 * cycle. `spaces.ts` keeps the space lifecycle; this module keeps topics.
 *
 * `TopicId` is branded and minted ONLY here, so a `contains`-edge writer can take a
 * `TopicId` rather than a `string`: a fourth producer then cannot skip the fence, the space
 * check, the clamp, the secret screen, the revive arm and the fold by passing an id it
 * happens to hold. `createClaim`'s `topicNoteId` is still a `string` at this task and is
 * where the brand has to land next — narrowing it is what turns the sentence above from a
 * convention into a compile error, and it is a `claims.ts` edit, deliberately not made here
 * (this module imports `looksLikeSecret` from it, so the back-reference must be `import
 * type` or it is the runtime cycle this module was split out to avoid).
 *
 * A BRAND CLOSES THE DISPATCH AND NOT THE INTERIOR OF THE BRANCH, so the seven interior
 * obligations are listed here side by side and each arm below names the one it discharges:
 *   1. fence          — `spaceAcceptsWrites`, first statement, inside the caller's tx
 *   2. handle arm     — a live topic node in THIS space, else fall through as words
 *   3. fold           — normalized-title hit on a live topic reuses it
 *   4. revive         — normalized-title hit on a TOMBSTONE clears `deleted_at`
 *   5. clamp          — `fitTopicTitle`, 64 chars, single line
 *   6. secret screen  — a manifest-bound title may not look like a credential
 *   7. default        — blank resolves to `DEFAULT_TOPIC_KEY`
 * The eighth obligation somebody adds must be added to this list too.
 */
declare const topicId: unique symbol;
export type TopicId = string & { readonly [topicId]: true };
export type TopicState = "default" | "existing" | "revived" | "created" | "secret_fallback";

/**
 * The JS RENDERING of `uniq_vnotes_topic_title`'s expression — for the error message and
 * for the parity test, and DELIBERATELY NOT for finding a row (review HIGH-1).
 *
 * Deliberately NOT `text.ts::norm`, whose docstring forbids exactly this: its three live
 * callers ask a question answered fresh against current rows every time and are therefore
 * free to change its answer, while an index expression over a populated table is frozen.
 * `legacyIdemKeyNorm` and `dedupKeyNorm` are the two prior instances of the same split;
 * this is the third, and it is the first one that a frozen copy could not actually
 * satisfy — `text.ts`'s roll-call records that corollary beside it.
 *
 * THE TWIN HAS THREE OPERATIONS, and an earlier draft of this docstring enumerated two.
 * The third is why this function is off the lookup path:
 *
 *   collapse — ASCII class written out, not `\s`. JavaScript's `\s` matches U+00A0 and
 *              Postgres's `[[:space:]]` does not, so a `\s` collapse here would fold a
 *              title the index thinks is distinct.
 *   trim     — `.replace(/^ +| +$/g, "")`, not `.trim()`, which is the same bug one
 *              operation over (NEW-5): JS `trim` is Unicode-aware and strips U+00A0 while
 *              `btrim(x)` with no second argument strips ASCII spaces only.
 *   case     — AND THIS ONE CANNOT BE PINNED AT ALL. `lower()` follows the database's
 *              collation (`en_US.utf8` on this deployment) and `toLowerCase()` follows
 *              Unicode default casing, and they measurably disagree: U+0130, the Turkish
 *              dotted capital I, lowercases to plain `i` in Postgres and to `i` + U+0307
 *              in JS; a word-final capital sigma lowercases to U+03C3 in Postgres and to
 *              final sigma U+03C2 in JS. No character class closes that, and unlike the
 *              whitespace halves it has no pre-normalizer — `fitTopicTitle` collapses
 *              whitespace and does NOT case-fold, so the unreachability argument that
 *              covers the first two operations does not extend to this one.
 *
 * So the resolver stopped computing the fold in JS: `foldOf` computes it in SQL on both
 * sides of every comparison, which makes divergence unrepresentable on the read path
 * rather than merely unlikely, and the 23505 catch on the insert degrades any residual
 * disagreement to reuse. What this function is still for is the message text and the
 * parity test — which asserts SQL agreement for the two whitespace operations and does
 * NOT claim it for case, because that claim would be false.
 */
export const topicTitleNorm = (raw: string) =>
  raw.toLowerCase().replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "");

/** The fold of the STORED title, as SQL. Byte-identical to `uniq_vnotes_topic_title`'s so
 *  the planner can use the index. */
const foldedTitle = sql`lower(btrim(regexp_replace(${vaultNotes.title}, '[[:space:]]+', ' ', 'g')))`;

/** The same fold of a CANDIDATE title, also as SQL, so both sides of every comparison are
 *  computed by the same engine under the same collation. This is what closes HIGH-1: with
 *  a JS-computed right-hand side the case operation could disagree with the index, and the
 *  lookup would miss a row the insert then collided with. Immutable functions over a bound
 *  parameter, so the expression index is still usable. */
const foldOf = (raw: string) => sql`lower(btrim(regexp_replace(${raw}::text, '[[:space:]]+', ' ', 'g')))`;

/** Whether a failed insert is the title fold saying "somebody already has this subject".
 *  Named rather than "any 23505": a foreign-key or check failure is a fault, and answering
 *  it with "reuse the existing topic" would report a real defect as routine reuse. Drizzle
 *  wraps driver errors from v0.36 on and keeps the `pg` error as `cause`; both shapes are
 *  read rather than pinning a version — the same test `barrier.ts` makes. */
function isTitleFoldConflict(e: unknown): boolean {
  const err = (e as { code?: unknown; constraint?: unknown }).code
    ? (e as { code?: unknown; constraint?: unknown })
    : ((e as { cause?: { code?: unknown; constraint?: unknown } }).cause ?? {});
  return err.code === "23505" && err.constraint === "uniq_vnotes_topic_title";
}

export async function resolveTopic(
  spaceId: string,
  nameOrHandle: string | undefined,
  ex?: Ex,
  opts?: { resolveHandle?: (h: string) => HandleTarget | null },
): Promise<{ id: TopicId; title: string; state: TopicState }> {
  // FOUR TO FIVE statements now, not one, so without a transaction this is not a move but
  // a handful of autocommits — and `insertNode`'s docstring says a node row "exists only as
  // half of a subtype write, so there is no such thing as creating one outside somebody
  // else's transaction". A crash between the node insert and the note insert leaves a
  // PERMANENT orphan node. The `!ex || ex === db` shape is the one `getOrCreateTopicNote`
  // and `createClaim` both document: `Ex` permits passing the pool EXPLICITLY, and
  // "omitted" and "explicit db" must not mean different things.
  if (!ex || ex === db) return db.transaction((tx) => resolveTopic(spaceId, nameOrHandle, tx, opts));

  // (1) fence. First statement inside the transaction, so the space row is the first lock
  // this move takes - `retireProjectSpace` takes it first too, and a shared order is what
  // keeps the two from deadlocking.
  //
  // It is the ENTRANCE THAT CREATES, which is the one a fence written against the claim
  // writers alone would miss, and it is reachable: `migrateMemoryDocs` opens the topic note
  // BEFORE its first claim, so a bullet-less legacy document migrating during the window
  // between teardown's two transactions would commit an empty topic into a retired space
  // without ever meeting the claim fence. One empty note and no user content is a small
  // harm — but this feature's whole history is a guard standing at one entrance of two, so
  // it is closed rather than noted. The migration itself does not rely on the throw: it
  // checks and SKIPS, because a deleted project's document is nothing to carry, not a
  // failure to retry every boot. (It sat on `getOrCreateTopicNote` until slice 2 made that
  // function a wrapper over this one; it guards the same act from one step closer to it.)
  if (!(await spaceAcceptsWrites(spaceId, ex))) {
    throw new Error(`space ${spaceId} is retired; refusing to resolve a topic in it`);
  }

  // (5) clamp, applied before every later decision so each of them sees the stored form.
  const raw = fitTopicTitle(nameOrHandle ?? "");

  // (7) default.
  if (!raw) return { ...(await topicByKey(spaceId, DEFAULT_TOPIC_KEY, ex)), state: "default" };

  // (2) handle arm. A handle from ANOTHER space, or a fabricated one, falls through to
  // the title arms AS WORDS - never an error the model has to handle, and never a
  // cross-space attach. That fall-through is the arm, not a gap in it.
  //
  // `kind: "n"` is the HANDLE LETTER, not a node kind: `handles.ts` names the five, and
  // only a note handle can address a topic. The space is checked TWICE and on purpose —
  // once against what the map claims (`t.spaceId`) and once against the row itself, so a
  // target carrying the wrong space cannot attach a claim across the boundary.
  if (HANDLE_RE.test(raw) && opts?.resolveHandle) {
    const t = opts.resolveHandle(raw);
    if (t && t.spaceId === spaceId && t.kind === "n") {
      const [live] = await ex
        .select({ id: vaultNotes.id, title: vaultNotes.title })
        .from(vaultNotes)
        .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
        .where(and(
          eq(vaultNotes.id, t.nodeId),
          eq(vaultNotes.spaceId, spaceId),
          eq(vaultNotes.kind, "memory_topic"),
          isNull(vaultNodes.deletedAt),
        ))
        .limit(1);
      if (live) return { id: live.id as TopicId, title: live.title, state: "existing" };
    }
  }

  // (6) secret screen. A topic title is destined for the ALWAYS-ON manifest tier, so a
  // secret-shaped name may not become one. Screened before the fold, so a credential
  // never even reserves a title under the unique index.
  //
  // Both fallback arms return the DEFAULT TOPIC'S OWN TITLE rather than
  // `TOPIC_LABELS[DEFAULT_TOPIC_KEY]` (review LOW-3): the row the key landed on may be a
  // user's own topic that the fold adopted, and quoting the label back at a caller whose
  // stored title says something else is the display/identity conflation this module was
  // built to end. Free, because `topicByKey` reads the title in the query it already runs.
  if (looksLikeSecret(raw)) {
    return { ...(await topicByKey(spaceId, DEFAULT_TOPIC_KEY, ex)), state: "secret_fallback" };
  }

  // (3)+(4). ONE read answers both: the index is title-only, so a tombstone is found by
  // the same query and told apart by `deleted_at`.
  //
  // BOTH SIDES OF THIS COMPARISON ARE COMPUTED BY POSTGRES (review HIGH-1). It used to be
  // `foldedTitle = ${topicTitleNorm(raw)}` — the index's expression on the left and a JS
  // twin of it on the right — and the twin's case operation disagrees with `lower()` on
  // this collation, so a title like the Turkish `I` missed here, collided on the index one
  // statement later, and threw `vanished after insert` on the hot path of a turn. `norm`'s
  // docstring says a persisted key gets its own frozen copy; what this taught is the
  // corollary — when the copy cannot be frozen faithfully, do not compute the key in JS at
  // all. `topicTitleNorm` survives for the message and the parity test.
  const [hit] = await ex
    .select({ id: vaultNotes.id, title: vaultNotes.title, deletedAt: vaultNodes.deletedAt })
    .from(vaultNotes)
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
    .where(and(
      eq(vaultNotes.spaceId, spaceId),
      eq(vaultNotes.kind, "memory_topic"),
      sql`${foldedTitle} = ${foldOf(raw)}`,
    ))
    .limit(1);
  if (hit && !hit.deletedAt) return { id: hit.id as TopicId, title: hit.title, state: "existing" };
  if (hit && hit.deletedAt) {
    // (4) revive, through the ONE inverse of a node delete (`restoreNode`), and not a bare
    // update here. What comes back with the identity is EXACTLY the edges the delete closed:
    // `restoreNode` reopens the rows stamped with this tombstone's own `deleted_at` and
    // nothing else, so an edge somebody cut before the delete stays cut.
    //
    // Leaving them closed was the older shape and it was wrong for a reason nothing on this
    // path can see: `deleteNode` closes a topic's `contains` edges and leaves its
    // `note_claims` rows alone, so a revived topic with its filings intact and its edges
    // closed is precisely the divergence `containsParity` exists to report — and the next
    // `contains` write into it then throws outside production. The owner's own undo
    // (`restoreNote`) already reopened them; two revive paths disagreeing about that is what
    // the fix rounds calls a one-sided cure.
    await restoreNode(hit.id, spaceId, hit.deletedAt, ex);
    await projectNoteDoc(hit.id, ex);
    return { id: hit.id as TopicId, title: hit.title, state: "revived" };
  }

  // Miss: insert the node and the note UNDER A SAVEPOINT, racing on
  // `uniq_vnotes_topic_title`. `topic_key := id`: agent- and user-created topics are
  // nanoid-identified, opaque, and never rendered.
  //
  // A savepoint rather than `onConflictDoNothing` (review HIGH-1), and it buys two things
  // the older shape did not have. A plain insert RAISES on the conflict instead of
  // returning an empty array, so the loser learns WHICH constraint refused it and a
  // foreign-key or check failure can no longer be read as "somebody else got here first";
  // and `rollback to savepoint` takes the node row back with the note attempt, so there is
  // no orphan to delete by hand and no hard node delete in this module at all. The
  // caller's transaction is untouched either way, which is the whole reason this is a
  // savepoint and not a bare `try` around a poisoned transaction.
  const id = nanoid();
  const lostTheRace = await ex
    .transaction(async (sp) => {
      await insertNode({ id, spaceId, kind: "note" }, sp);
      await sp
        .insert(vaultNotes)
        .values({ id, spaceId, topicKey: id, title: raw, kind: "memory_topic", currentRevision: 1 });
      return false;
    })
    .catch((e: unknown) => {
      if (!isTitleFoldConflict(e)) throw e;
      return true;
    });
  if (lostTheRace) {
    // Re-read with the SQL fold — the same expression the index used to refuse us, so this
    // finds the winner's row whatever the two case-folds think of each other. This is the
    // DEGRADE that makes the case divergence survivable: a disagreement costs a wasted
    // insert and reuses the existing topic, where it used to throw. `topicTitleNorm` is
    // called here only to name the subject in the message that fires if the row is somehow
    // still absent.
    const [won] = await ex
      .select({ id: vaultNotes.id, title: vaultNotes.title })
      .from(vaultNotes)
      .where(and(
        eq(vaultNotes.spaceId, spaceId),
        eq(vaultNotes.kind, "memory_topic"),
        sql`${foldedTitle} = ${foldOf(raw)}`,
      ))
      .limit(1);
    if (!won) throw new Error(`topic "${topicTitleNorm(raw)}" vanished after insert`);
    return { id: won.id as TopicId, title: won.title, state: "existing" };
  }
  // Revision 1 for the new topic, through the ONE writer of a version row. Not through
  // `createNote`, which owns the whole node+note+version move: this arm needs the note
  // insert to be the one racing on `uniq_vnotes_topic_title`, and to lose that race without
  // taking the caller's transaction with it. Task 4 read that requirement off an
  // `onConflictDoNothing`; the savepoint above is the same requirement met by a construct
  // that also says which constraint refused. What Task 4 collapses is the part that was
  // duplicated — the version insert and the pointer update — so that "no path creates a
  // note without a revision 1" is a property of `insertNoteVersion` being the only
  // IMPLEMENTATION of that write rather than of remembering. Not "the only caller": it has
  // three (`createNote`, `reviseNote`, and this), which is the point — three callers, one
  // implementation, one grep (T4 review L1).
  //
  // `ownerAuthored()`, so the horizon `createNote` would have armed is null here anyway: a
  // topic the person's own filing created is not agent content and does not expire.
  await insertNoteVersion(
    { noteId: id, spaceId, revision: 1, title: raw, bodyMarkdown: "", sourceClass: ownerAuthored(),
      // No `messageId` in the provenance, deliberately: no turn wrote this container, and
      // the chat notice's predicate is exactly that key — so a topic auto-created while
      // filing a fact never announces itself as something the assistant remembered.
      provenance: { kind: "topic_created" } },
    ex,
  );
  await projectNoteDoc(id, ex);
  return { id: id as TopicId, title: raw, state: "created" };
}

/** A memory topic is a note of kind `memory_topic`, identified by `topic_key`; the
 *  partial unique index on (space, key) is scoped to that kind, so it is the same race
 *  and the same resolution as `getOrCreateSpace`.
 *
 *  The stored `title` is a SEED for display, not the identity: it is written once, at
 *  creation, from the label table, and nothing reads it to find a row. That is what
 *  makes a rename control safe to build in plan D2 — it will write `title` and leave
 *  `topic_key` alone.
 *
 *  A THIN WRAPPER over `resolveTopic` since slice 2 (H5). It keeps the `topic_key` lookup
 *  — a key is not a title, and a system topic is addressed by key — but creation goes
 *  through the ONE producer, so the label's normalized title meets `uniq_vnotes_topic_title`
 *  in the resolver's fold rather than in an `onConflictDoNothing` whose re-read keys on
 *  `topic_key` and therefore reports a row that exists as "vanished after insert".
 *
 *  The retired-space fence moved INTO `resolveTopic` with the creation it guards, and the
 *  `topic_key` hit above it needs none: `retireProjectSpace` deletes every note in the
 *  space before it closes, and nothing can create one afterwards, so a found row in a
 *  retired space does not exist. */
export async function getOrCreateTopicNote(spaceId: string, topicKey: string, ex?: Ex): Promise<TopicId> {
  if (!ex || ex === db) return db.transaction((tx) => getOrCreateTopicNote(spaceId, topicKey, tx));
  return (await topicByKey(spaceId, topicKey, ex)).id;
}

/** The body of `getOrCreateTopicNote`, returning the row's TITLE as well — which the two
 *  fallback arms of `resolveTopic` need and the public signature does not carry. Requires
 *  a transaction: it is the same act, not a weaker one. */
async function topicByKey(spaceId: string, topicKey: string, ex: Ex): Promise<{ id: TopicId; title: string }> {
  const [found] = await ex
    .select({ id: vaultNotes.id, title: vaultNotes.title })
    .from(vaultNotes)
    .where(and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.topicKey, topicKey), eq(vaultNotes.kind, "memory_topic")))
    .limit(1);
  if (found) return { id: found.id as TopicId, title: found.title };
  const label = TOPIC_LABELS[topicKey] ?? topicKey;
  const r = await resolveTopic(spaceId, label, ex);
  // A system topic is addressed BY KEY forever after, so the key is stamped on whatever
  // row the fold landed on. Guarded on the row not already holding a MEANINGFUL key: a
  // resolver-minted topic is self-keyed (`topic_key = id`, opaque and never rendered) and
  // an old plain note has none, and both of those are a row that may take the system key
  // — an existing topic that already answers to a different key keeps its own identity and
  // is simply returned. Without the stamp the key would never land at all, and the very
  // next call would re-resolve by TITLE: rename the topic once and the key would open a
  // second one, which is precisely the fork `topic_key` exists to prevent.
  await ex
    .update(vaultNotes)
    .set({ topicKey })
    .where(and(
      eq(vaultNotes.id, r.id),
      or(isNull(vaultNotes.topicKey), eq(vaultNotes.topicKey, vaultNotes.id)),
    ));
  return { id: r.id, title: r.title };
}
