import { and, eq, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { vaultNodes, vaultNotes, vaultNoteVersions } from "@/lib/db/schema";
import { looksLikeSecret } from "./claims";
import { ownerAuthored } from "./grounding";
import { HANDLE_RE, type HandleTarget } from "./handles";
import { insertNode } from "./nodes";
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
 * A FROZEN copy, and the JS half of `uniq_vnotes_topic_title`'s expression.
 *
 * Deliberately NOT `text.ts::norm`, whose docstring forbids exactly this: its three live
 * callers ask a question answered fresh against current rows every time and are therefore
 * free to change its answer, while this one is computed at write time and frozen into an
 * index over a populated table. `legacyIdemKeyNorm` and `dedupKeyNorm` are the two prior
 * instances of the same split; this is the third and it is listed in `text.ts`'s roll-call
 * beside them.
 *
 * ASCII whitespace only, in BOTH operations, and the character classes are written out
 * rather than reached for. JavaScript's `\s` matches U+00A0 and Postgres's `[[:space:]]`
 * does not, so a `\s` collapse here would fold a title the index thinks is distinct — a
 * silent duplicate topic under the one constraint built to make duplicates impossible.
 *
 * `.trim()` IS THE SAME BUG ONE OPERATION OVER, which is why it is not used (review
 * NEW-5). JS `trim` is Unicode-aware and strips U+00A0; `btrim(x)` with no second argument
 * strips ASCII spaces only. So a LEADING or TRAILING non-breaking space would fold in JS
 * and survive in SQL — the same asymmetry, moved from the collapse to the trim, and just
 * as invisible. `.replace(/^ +| +$/g, "")` matches `btrim`'s actual behavior.
 *
 * Both sides are pinned by the 23505 test and the NBSP case below.
 */
export const topicTitleNorm = (raw: string) =>
  raw.toLowerCase().replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "");

/** The fold, as SQL, and the only place this expression is written on the query side.
 *  Byte-identical to `uniq_vnotes_topic_title`'s so the planner can use the index. */
const foldedTitle = sql`lower(btrim(regexp_replace(${vaultNotes.title}, '[[:space:]]+', ' ', 'g')))`;

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
  if (!raw) {
    return {
      id: await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY, ex),
      title: TOPIC_LABELS[DEFAULT_TOPIC_KEY],
      state: "default",
    };
  }

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
  if (looksLikeSecret(raw)) {
    return {
      id: await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY, ex),
      title: TOPIC_LABELS[DEFAULT_TOPIC_KEY],
      state: "secret_fallback",
    };
  }

  // (3)+(4). ONE read answers both: the index is title-only, so a tombstone is found by
  // the same query and told apart by `deleted_at`.
  //
  // `topicTitleNorm`, NOT `text.ts::norm` (MED-11). `norm`'s own docstring states the rule
  // in as many words after two prior instances: "a new persisted key gets its OWN frozen
  // copy, it does not import this". This expression is the JS twin of a GENERATED,
  // GIN-adjacent unique index over a populated table — computed once at write time and
  // frozen — while `norm`'s live callers are explicitly free to change its answer whenever
  // a better one is found. One function cannot hold both requirements, which is why
  // `legacyIdemKeyNorm` and `dedupKeyNorm` already exist as separate frozen copies.
  const folded = topicTitleNorm(raw);
  const [hit] = await ex
    .select({ id: vaultNotes.id, title: vaultNotes.title, deletedAt: vaultNodes.deletedAt })
    .from(vaultNotes)
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
    .where(and(
      eq(vaultNotes.spaceId, spaceId),
      eq(vaultNotes.kind, "memory_topic"),
      sql`${foldedTitle} = ${folded}`,
    ))
    .limit(1);
  if (hit && !hit.deletedAt) return { id: hit.id as TopicId, title: hit.title, state: "existing" };
  if (hit) {
    // (4) revive: clear the node's tombstone. Its edges stay soft-deleted - a revived
    // topic gets its identity back, not a resurrection of relationships the person
    // removed. `contains` edges are re-created by whatever files into it next.
    await ex.update(vaultNodes).set({ deletedAt: null }).where(eq(vaultNodes.id, hit.id));
    await projectNoteDoc(hit.id, ex);
    return { id: hit.id as TopicId, title: hit.title, state: "revived" };
  }

  // Miss: insert, racing on `uniq_vnotes_topic_title` with onConflictDoNothing + re-read
  // - the shape `getOrCreateSpace` already uses. `topic_key := id`: agent- and
  // user-created topics are nanoid-identified, opaque, and never rendered.
  const id = nanoid();
  await insertNode({ id, spaceId, kind: "note" }, ex);
  const inserted = await ex
    .insert(vaultNotes)
    .values({ id, spaceId, topicKey: id, title: raw, kind: "memory_topic", currentRevision: 1 })
    .onConflictDoNothing()
    .returning({ id: vaultNotes.id });
  if (!inserted.length) {
    // The loser of the race owns the cleanup, because the winner cannot see what it
    // displaced. Hard, and this is `getOrCreateTopicNote`'s documented second hard node
    // delete: the node is two statements old, has no edges, and lost its note.
    await ex.delete(vaultNodes).where(eq(vaultNodes.id, id));
    const [won] = await ex
      .select({ id: vaultNotes.id, title: vaultNotes.title })
      .from(vaultNotes)
      .where(and(
        eq(vaultNotes.spaceId, spaceId),
        eq(vaultNotes.kind, "memory_topic"),
        sql`${foldedTitle} = ${folded}`,
      ))
      .limit(1);
    if (!won) throw new Error(`topic "${folded}" vanished after insert`);
    return { id: won.id as TopicId, title: won.title, state: "existing" };
  }
  // Revision 1 for the new topic. Inline here and NOT via `notes.ts`'s `createNote`,
  // which does not exist yet at this task; Task 4 collapses these five lines onto it.
  const versionId = nanoid();
  await ex.insert(vaultNoteVersions).values({
    id: versionId, noteId: id, revision: 1, title: raw, bodyMarkdown: "",
    sourceClass: ownerAuthored(), provenance: { kind: "topic_created" },
  });
  await ex.update(vaultNotes).set({ currentVersionId: versionId }).where(eq(vaultNotes.id, id));
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
  const [found] = await ex
    .select({ id: vaultNotes.id })
    .from(vaultNotes)
    .where(and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.topicKey, topicKey), eq(vaultNotes.kind, "memory_topic")))
    .limit(1);
  if (found) return found.id as TopicId;
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
  return r.id;
}
