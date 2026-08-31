import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { noteClaims, vaultClaims, vaultNodes, vaultNotes, vaultNoteVersions } from "@/lib/db/schema";
import { fitSlotKey, fitStatement, looksLikeSecret, type ClaimHead, type SourceClass } from "./claims";
import { fitNoteTitle } from "./notes";
import { type Ex } from "./spaces";
import { TOPIC_LABELS, fitTopicTitle } from "./topics";
import { norm } from "./text";

/**
 * THE one route from stored text to the model.
 *
 * `recentFacts` (the system-prompt manifest) and `memory_search` each used to carry their
 * own copy of the head/not-sensitive predicate, and `mismatch` a third in JavaScript. That
 * is this feature's recurring defect in its purest form — a rule at one entrance while a
 * second walks past it — and it has now produced twelve instances, the eleventh being a
 * fifth reader that an enumeration built from one accessor's call sites simply did not
 * contain. So the predicate is not written down once per reader; it is written here, and a
 * reader that wants stored text for a prompt has to come through one of this module's
 * MINTS — `listManifestClaims`, `listManifestTopics`, `listMemoryToolRows`, `modelTextOf`.
 *
 * WHAT THE DECISION IS NOW, and it is no longer one `WHERE`. It is a CHANNEL clause over
 * `prompt_access` — a generated column, so no writer can set it by hand — ANDed with one
 * of the liveness arms below:
 *
 *  - `manifest` is the always-on tier: `listManifestClaims` and `listManifestTopics`.
 *  - `manifest` OR `memory_search` is the memory-TOOL tier: `listMemoryToolRows`, and
 *    `modelTextOf` for a head its caller already read.
 *  - `knowledge_search` reaches neither, in this slice; `owner_only` — which is exactly
 *    what `sensitive` generates — reaches no model channel at all, and `countWithheld` is
 *    the only thing that may say how many of those exist.
 *
 * Liveness is the other half and it lives in the arms (`liveClaimForModel`,
 * `liveNoteForModel`), because it cannot be a generated column: `expires_at` needs
 * `now()`. A mint ANDs a channel clause with the arm for the node kind it reads, and
 * nothing outside this module states either.
 *
 * There is no space clause in the arms: every mint takes its own scope from its caller,
 * and a predicate that guessed the scope would be answering a question it was not asked.
 */

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
/** The three channels named as one thing, for a reader that genuinely does not care which
 *  it holds. It is NOT a widening: `ModelText` is assignable FROM each brand and to none
 *  of them, so a value cannot be promoted from one channel's formatter to another's by
 *  passing through this name. It has no reader in slice 1 — the union arrives with the
 *  old single brand's deletion, and its first consumer ships beside `listEvidenceRows`. */
export type ModelText = ManifestText | MemoryToolText | EvidenceText;

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
  // used by listManifestClaims and listMemoryToolRows
  return and(
    isNull(vaultClaims.supersededAt),
    isNull(vaultNodes.deletedAt),
    isNull(vaultClaims.retiredAt),
    or(isNull(vaultClaims.expiresAt), gt(vaultClaims.expiresAt, sql`now()`)),
    eq(vaultClaims.sensitive, false),
  );
}

/**
 * Used by `listManifestTopics` and by `listMemoryToolRows`' note arm.
 *
 * The two version clauses land HERE, in the slice that created the rows they read. Head-
 * ness compares `revision` to `current_revision` — an INTEGER every row carries — and not
 * `current_version_id` to `id` (NEW-7): a join condition doing duty as a predicate drops
 * every note out of every note-reading mint the moment the pointer is NULL, which the
 * backfill window and any future repair can both produce.
 *
 * The `vault_note_versions` join is the MINT'S obligation, exactly like the `vault_nodes`
 * one; each arm assumes both have been made.
 */
function liveNoteForModel() {
  return and(
    isNull(vaultNodes.deletedAt),
    isNull(vaultNotes.retiredAt),
    or(isNull(vaultNotes.expiresAt), gt(vaultNotes.expiresAt, sql`now()`)),
    eq(vaultNoteVersions.sensitive, false),
    eq(vaultNoteVersions.revision, vaultNotes.currentRevision),
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
 * byte-identical across turns. A key with no label falls back to the HEAD VERSION's title,
 * which is what a user-named topic has — the version is where a rename will land, and
 * `vault_notes.title` is the compatibility copy the fold indexes.
 *
 * Private, and it serves `listManifestTopics` — one query, one mint, no reader outside the
 * module. (`listMemoryToolRows`' note arm resolves its own `topic` label the same way and
 * from the same table, because it needs it per NOTE rather than per topic with a count.)
 */
async function topicRows(spaceId: string, ex: Ex): Promise<{ title: string; count: number }[]> {
  const rows = await ex
    .select({
      id: vaultNotes.id,
      topicKey: vaultNotes.topicKey,
      title: vaultNoteVersions.title,
      count: sql<number>`count(${vaultClaims.id})::int`,
    })
    .from(vaultNotes)
    // The mint's own obligation: the arms above assume BOTH of these joins have been made.
    // The version join carries no head-ness condition of its own — that clause is in
    // `liveNoteForModel`, so a mint that made the join and forgot the arm returns every
    // revision instead of silently returning none.
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
    .innerJoin(vaultNoteVersions, eq(vaultNoteVersions.noteId, vaultNotes.id))
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
    .groupBy(vaultNotes.id, vaultNotes.topicKey, vaultNoteVersions.title)
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

/** Reciprocal rank fusion's constant. 60 is the published default and the reason it is a
 *  constant rather than a tuned number: RRF's whole point is that it needs no calibration
 *  between lanes whose scores are not on comparable scales. Raw FTS and trigram scores are
 *  never added — a weighted sum of them is a number that looks principled and is not. */
const RRF_K = 60;

/** How deep each lane goes before fusion. */
const LANE_DEPTH = 40;

/**
 * Candidate node ids by fused relevance, over the MODEL channel's text.
 *
 * Two lanes: `websearch_to_tsquery('simple', q)` against `model_tsv` ordered by
 * `ts_rank_cd`, and `norm_model_text % norm_q` / `norm_title % norm_q` ordered by
 * `similarity`. Top `LANE_DEPTH` of each, fused by RRF across lanes AND across queries,
 * then an exact-title and an exact-phrase boost.
 *
 * It returns IDS AND SCORES ONLY. The eligibility question is answered by the caller
 * against the authoritative row, which is the whole H7 fix: this table holds no
 * `superseded_at`, no `retired_at`, no `expires_at`, no `deleted_at`, and denormalizing
 * them here would require naming a single writer and proving it stands on every path that
 * can change any of four columns — the property this repo has failed to hold three times
 * by enumeration.
 *
 * PRIVATE, and it must stay private: a caller that could select rows and hand them to a
 * mint would be the "caller-supplied rows" the four-mints invariant forbids.
 */
async function fusedCandidates(
  spaceIds: string[],
  queries: string[],
  ex: Ex,
): Promise<{ nodeId: string; score: number }[]> {
  const raw = queries.map((s) => s.trim()).filter((s) => s.length > 0);
  const normed = raw.map(norm);
  if (!spaceIds.length || !raw.length) return [];
  // `sql.param(...)`, and the wrapper is not decoration — MEASURED, because the bare
  // `${raw}` form is wrong in a way that looks right. Drizzle 0.45.2's template treats a
  // plain JS array as a LIST OF CHUNKS and emits one placeholder per element bound to the
  // element, so `unnest(($1)::text[], …)` arrives holding the scalar `'arrangement'` and
  // Postgres answers `22P02 malformed array literal` — an error about the value, not about
  // the binding, which is what makes it read like bad data. `sql.param` passes the array
  // itself as one bind value, which the driver serializes as `text[]`.
  //
  // It is still a BIND PARAMETER, which is the whole point. NEVER reach for `sql.raw`
  // here: it splices its argument into the statement verbatim, and this is the one
  // function in the slice that takes model-authored words and puts them near a query.
  const result = await ex.execute(sql`
    with q as (
      select * from unnest(${sql.param(raw)}::text[], ${sql.param(normed)}::text[]) as t(raw, nq)
    ),
    lex as (
      select d.node_id,
             row_number() over (partition by q.raw
               order by ts_rank_cd(d.model_tsv, websearch_to_tsquery('simple', q.raw)) desc, d.node_id) as rnk
      from vault_search_documents d, q
      where d.space_id = any(${sql.param(spaceIds)}::text[])
        and d.model_tsv @@ websearch_to_tsquery('simple', q.raw)
    ),
    trg as (
      select d.node_id,
             row_number() over (partition by q.nq
               order by greatest(
                 coalesce(similarity(d.norm_model_text, q.nq), 0),
                 similarity(d.norm_title, q.nq)) desc, d.node_id) as rnk
      from vault_search_documents d, q
      where d.space_id = any(${sql.param(spaceIds)}::text[])
        and (d.norm_model_text % q.nq or d.norm_title % q.nq)
    ),
    fused as (
      select node_id, sum(1.0 / (${RRF_K} + rnk)) as score
      from (
        select node_id, rnk from lex where rnk <= ${LANE_DEPTH}
        union all
        select node_id, rnk from trg where rnk <= ${LANE_DEPTH}
      ) x
      group by node_id
    )
    select f.node_id,
           (f.score
             -- Exact title and exact phrase are the only boosts, and they are ADDED to a
             -- fused rank score rather than mixed with a raw lane score, so the scales
             -- stay comparable.
             + case when exists (select 1 from vault_search_documents d, q
                                 where d.node_id = f.node_id and d.norm_title = q.nq) then 1.0 else 0 end
             -- position(), not LIKE: a query containing % or _ would otherwise become a
             -- wildcard and boost everything. Escaping the pattern would be the other fix
             -- and it is one more thing to get right on every edit.
             + case when exists (select 1 from vault_search_documents d, q
                                 where d.node_id = f.node_id and position(q.nq in d.norm_model_text) > 0)
                    then 0.5 else 0 end)::float8 as score
    from fused f
    order by score desc, f.node_id asc
  `);
  return (result.rows as { node_id: string; score: number }[]).map((r) => ({
    nodeId: r.node_id,
    score: Number(r.score),
  }));
}

/** One row as a memory TOOL may see it — a DISCRIMINATED UNION since slice 2, because the
 *  mint returns notes beside claims and the two carry different text.
 *
 *  `value` is not model-facing text and is not branded: it rides along because the ledger's
 *  "is this already known" comparison has to read it, and that comparison must ask the same
 *  question this projection answers, not a wider one.
 *
 *  A `kind` discriminant rather than optional fields on one shape: a formatter has to
 *  re-exhaust a switch when a third node kind arrives, which is the same reason `op` and
 *  `grounding` are unions on the write tools. */
export type MemoryToolRow =
  | {
      id: string;
      revision: number;
      kind: "claim";
      excerpt: MemoryToolText;
      slotKey: MemoryToolText | null;
      value: unknown;
    }
  | {
      id: string;
      revision: number;
      kind: "note";
      title: MemoryToolText;
      excerpt: MemoryToolText;
      topic: MemoryToolText | null;
      sourceClass: SourceClass;
      spaceId: string;
    };

/** The columns every branch of the mint below reads. Written once because two copies of a
 *  select list is how one branch quietly stops returning a field the projection maps. */
const memoryToolColumns = {
  id: vaultClaims.id,
  revision: vaultClaims.revision,
  statement: vaultClaims.statement,
  slotKey: vaultClaims.slotKey,
  value: vaultClaims.value,
};

/** The note arm's columns. `revision` is the NOTE's `current_revision` and not the version
 *  row's: `[id@revision]` is how the model addresses a note in a later revise, and what it
 *  has to hold for the CAS is the number `reviseNote` compares against. */
const memoryToolNoteColumns = {
  id: vaultNotes.id,
  spaceId: vaultNotes.spaceId,
  revision: vaultNotes.currentRevision,
  noteKind: vaultNotes.kind,
  topicKey: vaultNotes.topicKey,
  title: vaultNoteVersions.title,
  body: vaultNoteVersions.bodyMarkdown,
  sourceClass: vaultNoteVersions.sourceClass,
};

/** The claim projection, lifted out of the mint because the query branch and the
 *  no-queries branch both apply it. Clamped and single-lined HERE, not only at the
 *  writers: a row recorded before `fitStatement` existed still renders into a tool
 *  reply. */
const asClaimRow = (r: {
  id: string;
  revision: number;
  statement: string;
  slotKey: string | null;
  value: unknown;
}): MemoryToolRow => {
  const slot = fitSlotKey(r.slotKey);
  return {
    id: r.id,
    revision: r.revision,
    kind: "claim",
    excerpt: mintMemoryTool(fitStatement(r.statement)),
    slotKey: slot ? mintMemoryTool(slot) : null,
    value: r.value,
  };
};

/** The note projection.
 *
 *  `topic` is the label the manifest would print for this note IF it is a topic container,
 *  resolved from the KEY exactly as `topicRows` resolves it, and `null` for a plain note.
 *  Null is a fact here rather than a lookup nobody wrote: in this slice a plain note has no
 *  containing topic — `note_claims` links a topic to CLAIMS — so there is nothing to name,
 *  and inventing a parent for it would be the mint asserting a relationship the graph does
 *  not hold.
 *
 *  The body is clamped by `fitStatement` for the same reason a statement is: this excerpt
 *  is one line of a bounded tool reply, and a note body is the one kind of stored text that
 *  is deliberately long. The full text is what `memory_open` is for (T12). */
const asNoteRow = (r: {
  id: string;
  spaceId: string;
  revision: number;
  noteKind: string;
  topicKey: string | null;
  title: string;
  body: string;
  sourceClass: SourceClass;
}): MemoryToolRow => ({
  id: r.id,
  revision: r.revision,
  kind: "note",
  title: mintMemoryTool(fitNoteTitle(r.title)),
  excerpt: mintMemoryTool(fitStatement(r.body)),
  topic:
    r.noteKind === "memory_topic"
      ? mintMemoryTool(fitTopicTitle(TOPIC_LABELS[r.topicKey ?? ""] ?? r.title))
      : null,
  sourceClass: r.sourceClass,
  spaceId: r.spaceId,
});

/**
 * THE memory-tool channel: `prompt_access in ('manifest','memory_search')` ANDed with
 * `liveClaimForModel`.
 *
 * WITH `queries`, it selects candidates from `vault_search_documents` by fused relevance
 * and then JOINS the authoritative row here. WITHOUT `queries`, it returns every eligible
 * row newest first, which is the shape the ledger's dedup asks for.
 *
 * WHAT THE JOIN GUARANTEES, precisely, because a wider statement was written here first and
 * was false: an ineligible row cannot consume one of the `limit` slots. It CAN consume one
 * of the `LANE_DEPTH` candidate slots, because `fusedCandidates` caps each lane before the
 * join and filters on `space_id` alone — not on `kind`, not on liveness. Slice 1 recorded
 * TWO kinds of row that ranked and were then dropped, and exactly one of them is closed
 * here:
 *
 *   - Topic notes, which this mint had no arm for. CLOSED: the note arm below makes those
 *     rows eligible, so a candidate slot spent on a note is now a slot that can be an
 *     answer.
 *   - Every superseded revision of a claim, because the projection deliberately keeps the
 *     predecessor's row. STILL OPEN, and unchanged by this slice: a claim with a long
 *     revision history can still push eligible heads out of the candidate set, and
 *     `omitted` reports only what the join saw.
 *
 * Nothing WRONG is returned; the remaining ceiling is spent on rows that cannot be answers.
 *
 * `last_used_at` is written HERE, not by the caller (M1): "one place, because two would
 * drift" is only true if the place is the mint. Both tables are stamped, each on its own
 * identity row — `vault_notes.last_used_at` sits on the note rather than the version,
 * because "when was this read" is a question about the note.
 *
 * It returns `{ rows, omitted }`, not a bare array. A response that hits a cap has to say
 * how many it left out — a silent truncation reads to the model as "that is all there is"
 * — and the count can only be computed where the slice happens, which is here. The
 * no-queries branch omits nothing by construction and returns 0.
 *
 * THE NOTE ARM IS IN THE QUERY BRANCH ONLY, which is a decision and not an omission. The
 * no-queries branch is the ledger's dedup asking "does this space already hold these
 * words" of the claims it is about to write; it has no rank to merge a second kind into,
 * and handing it notes would widen a comparison whose whole correctness argument is that
 * it asks exactly the question the projection answers.
 */
export async function listMemoryToolRows(
  spaceIds: string[],
  opts?: { queries?: string[]; limit?: number },
  ex: Ex = db,
): Promise<{ rows: MemoryToolRow[]; omitted: number }> {
  if (!spaceIds.length) return { rows: [], omitted: 0 };
  const limit = opts?.limit ?? 20;
  const channel = and(
    inArray(vaultClaims.spaceId, spaceIds),
    inArray(vaultClaims.promptAccess, ["manifest", "memory_search"]),
    liveClaimForModel(),
  );

  if (!opts?.queries?.length) {
    const rows = await ex
      .select(memoryToolColumns)
      .from(vaultClaims)
      .innerJoin(vaultNodes, eq(vaultNodes.id, vaultClaims.id))
      .where(channel)
      // The second order key is not decorative: `recorded_at` is identical across every
      // claim one transaction wrote.
      .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
    // No stamp. See the query branch below for why.
    return { omitted: 0, rows: rows.map(asClaimRow) };
  }

  const candidates = await fusedCandidates(spaceIds, opts.queries, ex);
  if (!candidates.length) return { rows: [], omitted: 0 };
  const rank = new Map(candidates.map((c, i) => [c.nodeId, i]));
  const candidateIds = candidates.map((c) => c.nodeId);

  const claims = await ex
    .select(memoryToolColumns)
    .from(vaultClaims)
    // The mint's own obligation: `liveClaimForModel` assumes this join has been made.
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultClaims.id))
    .where(and(channel, inArray(vaultClaims.id, candidateIds)));

  const notes = await ex
    .select(memoryToolNoteColumns)
    .from(vaultNotes)
    // Two obligations, both the mint's: `liveNoteForModel` assumes the node join AND the
    // version join. The version join is unconditional on purpose — head-ness is a clause
    // in the arm, not a join condition (NEW-7).
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
    .innerJoin(vaultNoteVersions, eq(vaultNoteVersions.noteId, vaultNotes.id))
    .where(
      and(
        inArray(vaultNotes.spaceId, spaceIds),
        inArray(vaultNoteVersions.promptAccess, ["manifest", "memory_search"]),
        liveNoteForModel(),
        inArray(vaultNotes.id, candidateIds),
      ),
    );

  // Re-order by the fused rank, THEN slice: the database returned the eligible subset in
  // whatever order it liked, the two arms are two separate reads, and the limit must fall
  // on the merged ranked list rather than on either arm's share of it.
  const ranked = [...claims.map(asClaimRow), ...notes.map(asNoteRow)].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
  const omitted = Math.max(0, ranked.length - limit);
  const rows = ranked.slice(0, limit);

  // THE STAMP LIVES IN THIS BRANCH, and its placement is the rule, not an optimization.
  // `last_used_at` means "the model received this row", and only a query branch can say
  // that. The no-queries branch above is a SET read — the ledger's dedup asking "does this
  // space already hold these words" — and stamping there would re-timestamp every live
  // claim in the space on every post-turn extraction, on the hot path, inside that caller's
  // transaction: a row lock over the whole space, and a retention signal that stops meaning
  // "the model read this" and starts meaning "the user had a turn".
  // An unstamped use is a smaller error than a space-wide stamp that destroys the signal.
  const stampedClaims = rows.filter((r) => r.kind === "claim").map((r) => r.id);
  const stampedNotes = rows.filter((r) => r.kind === "note").map((r) => r.id);
  if (stampedClaims.length) {
    await ex.update(vaultClaims).set({ lastUsedAt: new Date() }).where(inArray(vaultClaims.id, stampedClaims));
  }
  if (stampedNotes.length) {
    await ex.update(vaultNotes).set({ lastUsedAt: new Date() }).where(inArray(vaultNotes.id, stampedNotes));
  }

  return { omitted, rows };
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
