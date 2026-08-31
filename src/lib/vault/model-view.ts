import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { noteClaims, vaultClaims, vaultNodes, vaultNotes } from "@/lib/db/schema";
import { fitSlotKey, fitStatement, looksLikeSecret, type ClaimHead } from "./claims";
import { TOPIC_LABELS, fitTopicTitle, type Ex } from "./spaces";

/**
 * THE one route from stored text to the model.
 *
 * `recentFacts` (the system-prompt manifest) and `memory_search` each used to carry their
 * own copy of the head/confirmed/not-sensitive predicate, and `mismatch` a third in
 * JavaScript. That is this feature's recurring defect in its purest form — a rule at one
 * entrance while a second walks past it — and it has now produced twelve instances, the
 * eleventh being a fifth reader that an enumeration built from one accessor's call sites
 * simply did not contain. So the predicate is not written down four times; it is written
 * here, and a reader that wants claim text for a prompt has to come through this module.
 *
 * WHAT THE PREDICATE IS, and why each half is in it:
 *
 *  - `superseded_at IS NULL` — only a head is a fact; a predecessor is history.
 *  - `review_status = 'confirmed'` — quarantine. Since the authority cutover nothing
 *    GRANTS `confirmed` except `confirmClaim`, and its only caller is the human's
 *    confirm on the memory page. So this clause is what makes "the model sees only what
 *    a person approved" a property of the query rather than a claim in a comment. (A
 *    supersede's successor can be born `confirmed` too, but only by carrying across an
 *    approval on text it did not change — see `updateClaim`.)
 *  - `sensitive = false` — withholding from the MODEL. It never withholds from the
 *    authenticated owner: that surface is `memory-page.ts`, which deliberately does not
 *    use this module.
 *
 * There is no space clause: every caller supplies its own `spaceId`, and a projection
 * that guessed the scope would be answering a question it was not asked.
 */
export function modelVisible() {
  return and(
    isNull(vaultClaims.supersededAt),
    eq(vaultClaims.reviewStatus, "confirmed"),
    eq(vaultClaims.sensitive, false),
  );
}

declare const modelText: unique symbol;

/**
 * A string this module has decided the model may read.
 *
 * The brand is the second half of the boundary, and it is what makes a bypass fail
 * `tsc` rather than fail review: the model-facing formatters (`line` in `tools.ts`, the
 * manifest's fact lines, the lost-CAS sentence) accept `ModelText` and nothing else, so
 * a future reader that pulls a statement off `listHeadClaims` and prints it does not
 * compile. It is the same trick `StatementView` plays on the human surface, for the
 * mirror-image audience.
 *
 * The guarantee is real but not absolute — `x as ModelText` is still available to
 * somebody who writes it deliberately. `model-view.test.ts` is what catches that.
 */
export type ModelText = string & { readonly [modelText]: true };

const mint = (s: string) => s as ModelText;

declare const manifestText: unique symbol;
declare const memoryToolText: unique symbol;
declare const evidenceText: unique symbol;

/**
 * THREE CHANNELS, THREE SYMBOLS, MUTUALLY UNASSIGNABLE.
 *
 * `EvidenceText` cannot be passed where the manifest formatter wants `ManifestText`, and
 * there is deliberately NO widening function between them: promotion is impossible to
 * express, not merely discouraged. GPT proposed a channel-tagged wrapper object; a wrapper
 * is constructible by anyone and the discriminant is data, so the discrimination lives in
 * the type system instead, where a bypass fails `tsc`.
 *
 * `EvidenceText` has no mint in this slice. It is declared here because the union is what
 * makes the other two unassignable to each other's formatters, and because the mint that
 * produces it (`listEvidenceRows`) ships with its only reader, `knowledge_search`.
 */
export type ManifestText = string & { readonly [manifestText]: true };
export type MemoryToolText = string & { readonly [memoryToolText]: true };
export type EvidenceText = string & { readonly [evidenceText]: true };
// The `ModelText` UNION is not declared here. That name still belongs to the old single
// brand below until Task 11 deletes it; redefining it now would silently widen ModelClaim,
// manifest.ts and tools.ts in one edit — and, since the old declaration is still in this
// file, would not even compile.

const mintManifest = (s: string) => s as ManifestText;
const mintMemoryTool = (s: string) => s as MemoryToolText;

/**
 * ONE MODULE OWNS LIVENESS — the arms side by side, each the only one of its kind.
 *
 * The invariant is not "one function": round 1 published a single `liveForModel()` typed
 * entirely against `vaultClaims`, and three of the four mints do not read claims, so an
 * implementer would have had to write a note variant somewhere else — the exact fork the
 * invariant claimed to prevent. A fourth node kind has to add a fourth arm HERE.
 *
 * The `vault_nodes` join is the MINT'S obligation; each arm assumes it has been made.
 */
function liveClaimForModel() {
  // used by listManifestClaims, and from slice 2 by listMemoryToolRows
  return and(
    isNull(vaultClaims.supersededAt),
    isNull(vaultNodes.deletedAt),
    isNull(vaultClaims.retiredAt),
    or(isNull(vaultClaims.expiresAt), gt(vaultClaims.expiresAt, sql`now()`)),
    eq(vaultClaims.sensitive, false),
  );
}

/**
 * Used by listManifestTopics (and, from slice 2, by listMemoryToolRows' note arm and
 * listEvidenceRows' note arm).
 *
 * TWO CLAUSES ARE MISSING AND THEIR ABSENCE IS DATED, not an oversight:
 *   eq(vaultNoteVersions.sensitive, false)
 *   eq(vaultNoteVersions.revision, vaultNotes.currentRevision)
 * Both read `vault_note_versions`, whose rows migration step 4 creates in slice 2. Adding
 * them now would join against an empty table and drop EVERY note out of every note-reading
 * mint — the manifest would lose its `Topics:` block on live turns, and the byte-identity
 * parity control would fire on a cause that has nothing to do with the predicate it is
 * meant to be checking. They go in beside these three in the same commit that backfills
 * revision 1, and head-ness compares `revision` to `current_revision`, NOT the id pointer
 * (NEW-7: a join condition doing duty as a predicate, over a column that is nullable
 * during the backfill window).
 */
function liveNoteForModel() {
  return and(
    isNull(vaultNodes.deletedAt),
    isNull(vaultNotes.retiredAt),
    or(isNull(vaultNotes.expiresAt), gt(vaultNotes.expiresAt, sql`now()`)),
  );
}

/**
 * H8. The round-0 draft printed `Topics: <title> (12)` in the always-on tier with NO mint
 * producing it — free model-authored text in the strongest channel, outside the boundary
 * this module exists to hold. Three things live inside it and none of them is optional:
 * the `count > 0` visibility gate, the `looksLikeSecret` screen, and the
 * `TOPIC_TITLE_MAX_CHARS` clamp.
 *
 * The name the MODEL reads is resolved from the KEY, not from the stored title: the title
 * is a display seed a rename control may overwrite, and the manifest must be
 * byte-identical across turns. A key with no label falls back to the stored title, which
 * is what a user-named topic has.
 *
 * Private, and it serves `listManifestTopics` today and `listMemoryToolRows`' `topic`
 * label from slice 2 — one query, two mints, no reader outside the module.
 */
async function topicRows(spaceId: string, ex: Ex): Promise<{ title: string; count: number }[]> {
  const rows = await ex
    .select({
      id: vaultNotes.id,
      topicKey: vaultNotes.topicKey,
      title: vaultNotes.title,
      count: sql<number>`count(${vaultClaims.id})::int`,
    })
    .from(vaultNotes)
    // The mint's own obligation: the arms above assume this join has been made.
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
    .leftJoin(noteClaims, eq(noteClaims.noteId, vaultNotes.id))
    .leftJoin(
      vaultClaims,
      and(
        eq(vaultClaims.id, noteClaims.claimId),
        // The claim side needs its OWN node row for `liveClaimForModel`, and one join
        // cannot serve two node predicates — so the claim's liveness is expressed here
        // without the node clause. Both writers of `vault_nodes.deleted_at` are covered,
        // by two DIFFERENT arguments, and both are written down because the second one is
        // not implied by the first:
        //
        //   `deleteNode` is only ever called beside a supersede (`forgetClaim`,
        //   `forgetAllClaims`), so a soft-deleted claim node always carries
        //   `superseded_at`, which IS in this list.
        //
        //   `deleteSpaceNodes` does NOT supersede — it soft-deletes every node in a space
        //   at once — but its only caller, `retireProjectSpace`, hard-DELETEs the claim
        //   rows first, so the left join finds no row to count.
        //
        // A third writer of `deleted_at` would need its own argument or a second node
        // join here; there is no general rule covering them, which is the point of
        // enumerating rather than asserting.
        isNull(vaultClaims.supersededAt),
        isNull(vaultClaims.retiredAt),
        or(isNull(vaultClaims.expiresAt), gt(vaultClaims.expiresAt, sql`now()`)),
        eq(vaultClaims.sensitive, false),
        eq(vaultClaims.promptAccess, "manifest"),
      ),
    )
    .where(and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.kind, "memory_topic"), liveNoteForModel()))
    .groupBy(vaultNotes.id, vaultNotes.topicKey, vaultNotes.title)
    // Deterministic, because the byte-identity requirement depends on it: `id` (nanoid) is
    // the only stable key here — `createdAt` is not guaranteed to differ at millisecond
    // resolution between topics inserted in one transaction.
    .orderBy(asc(vaultNotes.id));
  return rows
    .map((r) => ({ title: TOPIC_LABELS[r.topicKey ?? ""] ?? r.title, count: r.count }))
    .filter((r) => r.count > 0 && !looksLikeSecret(r.title))
    .map((r) => ({ title: fitTopicTitle(r.title), count: r.count }));
}

export async function listManifestTopics(
  spaceId: string,
  ex: Ex = db,
): Promise<{ title: ManifestText; count: number }[]> {
  return (await topicRows(spaceId, ex)).map((r) => ({ title: mintManifest(r.title), count: r.count }));
}

/** Claim heads the ALWAYS-ON tier may print: `prompt_access = 'manifest'` ANDed with
 *  `liveClaimForModel`. Ordered `(recorded_at DESC, id ASC)` — the `id` tiebreak exists
 *  because `recorded_at` is identical across every claim one transaction wrote and the
 *  manifest has to be byte-identical across turns. */
export async function listManifestClaims(
  spaceId: string,
  ex: Ex = db,
): Promise<{ id: string; revision: number; statement: ManifestText }[]> {
  const rows = await ex
    .select({ id: vaultClaims.id, revision: vaultClaims.revision, statement: vaultClaims.statement })
    .from(vaultClaims)
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultClaims.id))
    .where(
      and(eq(vaultClaims.spaceId, spaceId), eq(vaultClaims.promptAccess, "manifest"), liveClaimForModel()),
    )
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
  return rows.map((r) => ({
    id: r.id,
    revision: r.revision,
    statement: mintManifest(fitStatement(r.statement)),
  }));
}

/** One head as the model may see it. `value` is not model-facing text and is not
 *  branded: it rides along because the ledger's "is this already known" comparison has
 *  to read it, and that comparison must ask the same question this projection answers,
 *  not a wider one. */
export type ModelClaim = {
  id: string;
  revision: number;
  statement: ModelText;
  slotKey: ModelText | null;
  value: unknown;
};

/** Clamped and single-lined at the projection, not only at the writers. A row recorded
 *  before `fitStatement` existed still renders into a prompt, and the manifest's `- «…»`
 *  fence is built for one bounded line. Doing it HERE means every model-facing reader
 *  gets it, including the next one. */
function project(row: {
  id: string;
  revision: number;
  statement: string;
  slotKey: string | null;
  value: unknown;
}): ModelClaim {
  const slot = fitSlotKey(row.slotKey);
  return {
    id: row.id,
    revision: row.revision,
    statement: mint(fitStatement(row.statement)),
    slotKey: slot ? mint(slot) : null,
    value: row.value,
  };
}

/** Every claim in one space that the model may read, newest first. The second order key
 *  is not decorative: `recorded_at` is identical across every claim one transaction
 *  wrote, and the manifest has to be byte-identical across turns. */
export async function listModelClaims(spaceId: string, ex: Ex = db): Promise<ModelClaim[]> {
  const rows = await ex
    .select({
      id: vaultClaims.id,
      revision: vaultClaims.revision,
      statement: vaultClaims.statement,
      slotKey: vaultClaims.slotKey,
      value: vaultClaims.value,
    })
    .from(vaultClaims)
    .where(and(eq(vaultClaims.spaceId, spaceId), modelVisible()))
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
  return rows.map(project);
}

/** The same decision for a head the caller ALREADY read — the lost-CAS reply, whose head
 *  comes from `findCurrentHead` because that function has to answer "does this chain
 *  exist" whatever the head's status is.
 *
 *  It returns `MemoryToolText`, not `ManifestText`: the reply is tool output. `null` means
 *  "not for the model", and the caller prints nothing rather than choosing its own filter
 *  — a lost CAS must not become a second way to read out what the manifest hides.
 *
 *  It does NOT also test `head.sensitive`: `sensitive` is exactly what makes
 *  `prompt_access` `owner_only`, and two tests for one fact is the second entrance this
 *  module exists to close. */
export function modelTextOf(head: ClaimHead): MemoryToolText | null {
  if (head.promptAccess !== "manifest" && head.promptAccess !== "memory_search") return null;
  return mintMemoryTool(fitStatement(head.statement));
}

/**
 * How many live heads this space holds that NO model channel may read — `owner_only`,
 * which is what `sensitive` generates.
 *
 * Query-independent by construction, which is the whole point of the sentence
 * `memory_search` builds from it: withholding a statement while still matching on it is
 * not withholding — a hit for `memory_search("diagnosis")` confirms the category the
 * withholding exists to protect. An aggregate, so no row limit can silently make it
 * look smaller than it is.
 */
export async function countWithheld(spaceId: string, ex: Ex = db): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(vaultClaims)
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultClaims.id))
    .where(
      and(
        eq(vaultClaims.spaceId, spaceId),
        eq(vaultClaims.promptAccess, "owner_only"),
        // Everything liveClaimForModel() excludes, MINUS its `sensitive = false` clause,
        // which is the very thing being counted. Written out rather than reusing the arm:
        // this is the one query whose subject is the rows that arm rejects, so calling it
        // would return zero by construction. The other four clauses must still hold — a
        // superseded, node-deleted, retired or expired sensitive head is not "withheld",
        // it is gone, and counting it would make the sentence the model reads on every
        // search overstate what exists.
        isNull(vaultClaims.supersededAt),
        isNull(vaultNodes.deletedAt),
        isNull(vaultClaims.retiredAt),
        or(isNull(vaultClaims.expiresAt), gt(vaultClaims.expiresAt, sql`now()`)),
      ),
    );
  return row?.n ?? 0;
}
