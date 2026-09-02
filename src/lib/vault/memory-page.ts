import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  chats, claimEvidence, memoryCandidates, messages, projects, spaces, vaultClaims,
} from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import type { SourceClass } from "./claims";
import { norm } from "./text";

/**
 * Everything the memory page shows, assembled server-side.
 *
 * The point of this module is what the page it replaces threw away. Two relations are
 * already populated and were both projected out by rendering memory as markdown:
 * `claim_evidence.message_id` records the conversation a fact came from, and
 * `vault_claims.supersedes` records what it replaced. Neither is new work; the page simply
 * stopped discarding them.
 *
 * A third, `note_claims`, files a fact under a topic, and this module deliberately does NOT
 * read it any more — see `factsOf`. The rail it fed was a filing system nothing files into,
 * and it kept a third of this account's approved facts off the screen.
 *
 * WHAT `sensitive` MEANS, because this surface is the one place it means something
 * different. The rule, in one sentence:
 *
 *   > `sensitive` is an advisory classification and it withholds from the MODEL. It
 *   > never withholds from the authenticated owner of the space. What the owner may see
 *   > is decided by ownership; what the model may see is decided by the owner.
 *
 * The three MODEL-facing readers are unchanged and must stay that way:
 *
 *   - `manifest.ts` — non-sensitive statement; a sensitive one withheld entirely, not
 *     even counted in its topic's counter.
 *   - `memory_search` (`tools.ts`) — statement plus `[id@revision]`; a sensitive one
 *     withheld behind a query-independent aggregate count.
 *   - `memory_open` (`read-tools.ts`) — the whole of one item, through the mint for its
 *     channel; a sensitive one is not found at all, because `owner_only` reaches no model
 *     channel and a per-handle "that one is withheld" would confirm the category.
 *     (The third reader used to be `mismatch`, the lost-CAS reply of the retired
 *     `memory_update`. It went with the tool: the new writers report a REVISION and never
 *     the text, so a lost CAS is no longer a way to read anything out.)
 *
 * THIS reader sends the text, sensitive or not, and marks it so the page can render the
 * advisory. It used to withhold, on a rule borrowed from those three, and that cost two
 * things at once: the person was to be asked to approve words the screen would not show
 * them, and — because the confirm path reasoned from the same premise — a candidate
 * whose slot a sensitive head occupied could never be confirmed at all. A display
 * decision had propagated into a concurrency outcome. The protection that genuinely
 * applies at a screen is shoulder-surfing, which is a RENDERING concern: the page blurs
 * a sensitive statement behind a reveal control, and the server does not refuse to send
 * what the owner already owns.
 *
 * Store-only visibility — keep a fact but never give it to the model — is a real and
 * separate want, and it needs a column of its own. Giving `sensitive` a third meaning
 * here is exactly the mistake this comment exists to undo.
 *
 * NOTHING DECIDES VISIBILITY ON THE OWNER'S OWN PAGE, and that is a change worth the
 * paragraph it replaces.
 *
 * This module used to filter both head selects on `review_status = 'confirmed'`, on the
 * reasoning that an unverified claim was quarantined material and belonged in the waiting
 * list rather than in the list of what the assistant is using — the same rule the
 * model-facing readers held. That reasoning was sound while a person's confirmation was
 * the ONLY thing that could put a fact in front of the model. Slice 2 removes that gate
 * (§11.9, H12): the agent writes live facts, so with the filter left in place every one
 * of them would be invisible on the only surface where a person can see, edit, undo or
 * delete it — and this release's own shipping copy would be false.
 *
 * WHAT REPLACED IT is `source_class`, and it answers a different question. The filter
 * answered "may this be shown"; the class answers "where did this come from", which is
 * what a person actually needs in order to judge a row. The channel a row may reach a
 * MODEL through is still decided — by the generated `prompt_access` column, read only by
 * `model-view.ts` — and that decision is unchanged and is not this module's. `review_status`
 * is kept as history and is read by no path here (§2.12).
 */

export type FactSource =
  | { kind: "chat"; chatId: string; chatTitle: string | null; at: string }
  | { kind: "chats"; count: number; latest: { chatId: string; chatTitle: string | null; at: string } }
  | { kind: "legacy" }
  | { kind: "unknown" };

/**
 * A stored statement and the flag that decides how legible it may be, as ONE value.
 *
 * The pairing is the point, and it is a correction. `sensitive` used to sit beside
 * `statement` as a sibling field, so every new place that rendered a statement had to
 * remember to pick the flag up — and within one commit two did not: the conflict line
 * blurred on the CANDIDATE's flag while printing the contested HEAD's words, and the
 * edit textarea read the raw text with no reveal at all. That is this feature's recurring
 * defect, a rule at one entrance while a second walks past it, and enumerating entrances
 * has now demonstrably failed to prevent it three times.
 *
 * So the text is not a `string` on this wire. A statement cannot be dropped into JSX, or
 * interpolated into a translated sentence, without failing `tsc` — the only thing that
 * consumes this shape is the `Statement` component, which is the single place in the
 * codebase that reads `sensitive` to decide legibility. A future entrance does not have
 * to remember the rule; it cannot compile without it.
 *
 * The guarantee is real but not absolute: `value.text` is still structurally reachable by
 * someone who writes it deliberately. `memory-statement.test.ts` is what catches that.
 */
export type StatementView = {
  /** Never render this directly — pass the whole object to `<Statement>`. */
  text: string;
  sensitive: boolean;
};

export type FactHistory = { statement: StatementView; at: string };

/**
 * WHERE A ROW CAME FROM, as one label the page renders without opening anything.
 *
 * CLASS = TRUST, PROVENANCE = MEDIUM (§2.3), and this union is that sentence in a type.
 * The first three arms come from `source_class` alone, because a trust tier is all those
 * classes assert. The last two are ONE class — `untrusted_derived` — split by the medium
 * recorded in `origin`, which is the only thing that can say whether the bytes came out
 * of a document or off a web page. Deriving the medium from the class instead is the
 * round-1 H2 mistake (`file_derived` named a medium and let a fetched page fall outside
 * every poisoning bound), and deriving the class from the medium is the same error
 * mirrored.
 *
 * A flattened `tag: string` was the other option and it is the one §9.1 forbids: "Director:
 * Olena" from a 2019 contract reading as a confirmed personal fact is exactly what one
 * generic card produces. The document arm carries its `name` as a VALUE so the translator
 * interpolates it — Ukrainian declines the words around a quoted title.
 */
export type TrustTag =
  | { kind: "user_direct" }
  | { kind: "owner_authored" }
  | { kind: "agent_inferred" }
  | { kind: "untrusted_document"; name: string }
  | { kind: "untrusted_web" };

export type FactView = {
  id: string;
  revision: number;
  statement: StatementView;
  recordedAt: string;
  source: FactSource;
  /** The trust tag, from `source_class` and `origin` — never from `prompt_access`. This
   *  page is the OWNER's surface and deliberately does not go through `model-view.ts`,
   *  which withholds from the model and never from the person, so no channel value
   *  travels on this wire at all. */
  trust: TrustTag;
  /** The immediately previous version. Carries its OWN sensitivity, which is not
   *  derivable from the successor's: `confirmClaim` raises a head's flag in place with no
   *  supersede, so a non-sensitive fact really can hold a predecessor that has since
   *  become sensitive. */
  previous: FactHistory | null;
};

/**
 * ONE HALF OF A DISAGREEMENT — a live head, with what it needs to be judged against the
 * other half. Both halves have the same shape because neither is privileged: §4.5 step 5
 * stores the correction live at its own class beside the fact it contests, and the person
 * decides which stands.
 */
export type ConflictSide = {
  id: string;
  revision: number;
  statement: StatementView;
  trust: TrustTag;
  at: string;
};

export type ConflictView = {
  /** The CONTESTING row — the newer statement, carrying `conflicts_with`. */
  claim: ConflictSide;
  /** The row it contests. Present by construction: `conflicts_with` is a composite FK to
   *  `vault_nodes`, so a dangling or cross-space pointer is unrepresentable rather than
   *  something this reader has to notice (round-2 N11). A pointer whose target has since
   *  been superseded or forgotten is not a live conflict and is not returned at all. */
  contested: ConflictSide;
};

/**
 * A row from the RETIRED review queue — read-only, and on its way out.
 *
 * `memory_candidates` stopped being written when the new write tools shipped (§11.8).
 * Its unresolved rows are not deleted with their producer, because a person may have
 * meant to keep one: they become the "Earlier suggestions" archive, which expires thirty
 * days after this release and takes the table with it (§2.12). Nothing is ever
 * auto-promoted out of it — a keep writes a real claim at `owner_authored`, which is a
 * person's act.
 */
export type ArchivedView = {
  id: string;
  statement: StatementView;
  createdAt: string;
  state: "pending" | "conflict";
  source: FactSource;
  /** For a row in `conflict`: the head it was recorded against. Keeping this one
   *  supersedes that one, and a person cannot make that choice against a fact they
   *  cannot see. `null` on a plain row, and also on the conflict the ledger recorded
   *  with no head to point at (the slot was contested and then vacated). */
  conflictsWith: FactHistory | null;
};

export type ScopeView = {
  scope: "user" | "project";
  projectId?: string;
  projectName?: string;
  /** Every LIVE HEAD in the space, newest first — whatever its `review_status`, matching
   *  the search when there is one, and never more than `FACT_LIMIT` of them. */
  facts: FactView[];
  /** How many matched the search, BEFORE the cap. Reported separately because the page
   *  has to be able to say "you are looking at 200 of 5000" — a count derived from
   *  `facts.length` could only ever say 200, which is the sentence being wrong exactly
   *  when it matters. */
  factsMatched: number;
  /** How many facts the scope holds at all, IGNORING the search. Its one reader is the
   *  "forget everything" dialog, which promises to forget everything and so cannot state
   *  a number the search box narrowed — a person who typed a word and then reset would be
   *  told two facts were going while fifty-one went. */
  factsTotal: number;
  /** Facts that disagree with each other, from the ONE reader of that state
   *  (`readConflicts`). Both halves also appear in `facts` — they are live heads, and
   *  nothing decides visibility on this page — so the card is a second VIEW of them and
   *  not a filter over the list, which is what keeps a second predicate from existing. */
  conflicts: ConflictView[];
  /** The retired review queue's leftovers. Empty for every account that never had one. */
  archive: ArchivedView[];
};

/**
 * WHEN THE ARCHIVE GOES, stated from the day it appears so the deadline is never a
 * surprise (§11.8).
 *
 * A literal release date rather than a per-row `created_at + 30 days`: the promise is
 * about the TABLE, which is dropped in one release, and a per-row horizon would show
 * eleven different dates for one event. It is the one date in this module a reader has to
 * keep true by hand, which is why it is a named constant beside the type it belongs to
 * rather than an expression inside a query.
 */
const ARCHIVE_RELEASED_ON = "2026-09-02";
export const ARCHIVE_DAYS = 30;

export function archiveExpiresAt(): string {
  return new Date(Date.parse(ARCHIVE_RELEASED_ON) + ARCHIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * How many facts one scope sends to the browser.
 *
 * At today's 51 it does nothing, and that is the point: the shape has to survive 5000
 * without anybody rewriting this module, and an unbounded list is the thing that would
 * have to be rewritten. The page says so in one sentence when `factsMatched` exceeds it
 * and points at the search box, rather than paginating — a person looking for one fact
 * reaches for words, not for page 7.
 */
export const FACT_LIMIT = 200;

/** Where a fact came from, in the shape the UI turns into one plain sentence.
 *
 *  `claim_evidence.message_id` has NO foreign key (see `schema.ts`), so a deleted
 *  message leaves a dangling id behind. The join is therefore a LEFT JOIN and a dangling
 *  row degrades to `unknown` rather than dropping the fact — a fact whose origin we can
 *  no longer name is still the user's fact.
 *
 *  Four shapes, because the brief asks what happens at each count: none from a legacy
 *  migration, none from a vanished message, one, and several. With several the UI says
 *  how many and names the most recent — listing them all turns a scannable line into a
 *  paragraph, and the newest is the one a person is looking for.
 *
 *  The chat join is scoped to the caller. The evidence's message belongs to this user's
 *  chat by construction today, and the filter is what keeps that true rather than
 *  assumed if a future writer ever attaches someone else's message id. */
function sourceOf(
  rows: { chatId: string | null; chatTitle: string | null; at: Date | null }[],
  origin: unknown,
): FactSource {
  const named = rows.filter((r): r is { chatId: string; chatTitle: string | null; at: Date } => !!r.chatId && !!r.at);
  if (!named.length) {
    // TWO origin kinds, and both are live data rather than one being history.
    // `legacy_memory_doc` is what the ledger stamped on a legacy PROVENANCE and what the
    // rows confirmed before slice 2 carry; `legacy_document` is what `migrateMemoryDocs`
    // now writes straight onto the claim (§11.11). Reading only the newer one would turn
    // "carried over from your earlier notes" into "the conversation is no longer
    // available" for every fact a person had already kept.
    const kind = (origin as { kind?: string } | null)?.kind;
    return kind === "legacy_memory_doc" || kind === "legacy_document"
      ? { kind: "legacy" }
      : { kind: "unknown" };
  }
  named.sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = { chatId: named[0].chatId, chatTitle: named[0].chatTitle, at: named[0].at.toISOString() };
  const distinct = new Set(named.map((r) => r.chatId)).size;
  return distinct === 1 ? { kind: "chat", ...latest } : { kind: "chats", count: distinct, latest };
}

/**
 * THE TRUST TAG, from the stored class and the stored medium, and from nothing else.
 *
 * A pure function beside `sourceOf` for the same two reasons that one is: this repo's
 * vitest runs with `environment: "node"` and has no React renderer, so a mapping inside a
 * component cannot be tested at all — and the `untrusted_derived` split is exactly the
 * kind of branch that rots silently.
 *
 * `legacy_confirmed` shares the `user_direct` arm because it means the same thing to the
 * person reading it: a pre-cutover claim they confirmed on this page IS something they
 * told Capka. That is a display equivalence, not a class equivalence — the two are still
 * different values in `source_class`, and `CLASS_RANK` in `write-tools.ts` is where their
 * shared authority is expressed for the supersede decision.
 *
 * The medium comes off `origin`, and the WEB arm is the fallback rather than the document
 * one. That is a fact about this release, not a preference: file ingestion is project-only
 * and lands in slice 3 (§5.0), so the only untrusted ingress reachable today is a fetched
 * page or a connector's output. When a source version starts naming a document, the name
 * arrives here as `origin.documentName` and the other arm lights up with no change to
 * this switch.
 */
export function trustTagOf(sourceClass: SourceClass, origin: unknown): TrustTag {
  switch (sourceClass) {
    case "user_direct":
    case "legacy_confirmed":
      return { kind: "user_direct" };
    case "owner_authored":
      return { kind: "owner_authored" };
    case "agent_inferred":
      return { kind: "agent_inferred" };
    case "untrusted_derived": {
      const name = (origin as { documentName?: unknown } | null)?.documentName;
      return typeof name === "string" && name.trim() ? { kind: "untrusted_document", name } : { kind: "untrusted_web" };
    }
  }
}

/**
 * ONE list of a scope's facts — every LIVE HEAD in the space, newest first.
 *
 * IT USED TO BE A LIST PER TOPIC, and that is what this replaces. The page drew a rail of
 * topic buttons over the result and showed one topic's facts at a time, so of the 51 facts
 * this account had approved it put 33 on screen; the other 18 sat behind four rail entries
 * (`health`, `people`, `preferences`, `work`) that no live write path has touched since the
 * vocabulary was narrowed to one key, and that a person had no reason to click. A fact
 * somebody confirmed and cannot find reads as a fact the system lost.
 *
 * So there is no note join here at all: the space is the scope, and a head belongs to this
 * list whether it hangs off a topic note, off four of them, or off none. The topic rows are
 * untouched in the database and the MODEL still sees topics (the manifest's counters are
 * unchanged) — this is navigation dropping a distinction the data never had, not a
 * migration.
 *
 * ORDERING is `recorded_at` descending, not alphabetical and not by topic: what changed
 * lately is how a person notices a wrong fact. The `id` tiebreak is not decorative —
 * `recorded_at` is identical across every claim one transaction wrote, and a list that
 * reshuffles between two loads of the same page is one a person cannot re-find a row in.
 *
 * FOUR STATEMENTS, not N+1, and the filter sits between the first and the rest: the heads,
 * then evidence and predecessors for the CAPPED page only. That is what keeps a 5000-fact
 * space from fanning out into two 5000-row joins to render 200 rows.
 */
async function factsOf(
  spaceId: string,
  userId: string,
  query: string,
): Promise<{ facts: FactView[]; matched: number; total: number }> {
  const heads = await db
    .select({
      id: vaultClaims.id,
      revision: vaultClaims.revision,
      statement: vaultClaims.statement,
      sensitive: vaultClaims.sensitive,
      recordedAt: vaultClaims.recordedAt,
      supersedes: vaultClaims.supersedes,
      origin: vaultClaims.origin,
      // The STORED tier, which is what the tag is made of. `prompt_access` is
      // deliberately not selected: it is the model's channel, and this page is the
      // owner's surface.
      sourceClass: vaultClaims.sourceClass,
    })
    .from(vaultClaims)
    // HEAD + SCOPE, and nothing else (§11.9). No `review_status`, no `prompt_access`:
    // the first is history and the second withholds from the MODEL, never from the
    // person whose space this is.
    .where(and(eq(vaultClaims.spaceId, spaceId), isNull(vaultClaims.supersededAt)))
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));

  // The search, and the one thing it must not do: look at `sensitive`.
  //
  // `sensitive` withholds from the MODEL and never from the authenticated owner — the rule
  // this feature has now broken five times by applying it at a human-facing entrance. A
  // search that silently skipped the owner's own sensitive facts would be the sixth, and
  // the worst-behaved of them: the row is not missing from a screen where its absence is
  // visible, it is missing from an answer to a question, which reads as "you never saved
  // that". So the predicate is over the STATEMENT alone, and the flag is not in scope here
  // at all. `Statement` still blurs the result; finding it and reading it are separate
  // questions and only the second one `sensitive` gets to answer.
  //
  // Normalized substring on both sides, through the same `norm` the ledger's dedup uses.
  // Nothing language-specific: plan C swaps this predicate for n-gram and embedding
  // matching behind the same call site, and a transliteration table added now would be an
  // enumerated-case hardcode to delete then.
  const needle = norm(query);
  const matched = needle ? heads.filter((h) => norm(h.statement).includes(needle)) : heads;
  const page = matched.slice(0, FACT_LIMIT);

  const factIds = page.map((f) => f.id);
  const evidenceRows = factIds.length
    ? await db
        .select({ claimId: claimEvidence.claimId, chatId: chats.id, chatTitle: chats.title, at: messages.createdAt })
        .from(claimEvidence)
        .leftJoin(messages, eq(messages.id, claimEvidence.messageId))
        .leftJoin(chats, and(eq(chats.id, messages.chatId), eq(chats.userId, userId)))
        .where(inArray(claimEvidence.claimId, factIds))
    : [];

  const predecessorIds = page.map((f) => f.supersedes).filter((v): v is string => !!v);
  const predecessors = predecessorIds.length
    ? await db
        // `sensitive` is selected, and its own value rather than the successor's. It was
        // once left out on the reasoning that sensitivity rises along a chain, so a
        // non-sensitive head could not have a sensitive ancestor — which is false:
        // `confirmClaim` raises the flag IN PLACE, with no supersede, so a predecessor
        // can become sensitive long after it was replaced.
        .select({
          id: vaultClaims.id,
          statement: vaultClaims.statement,
          sensitive: vaultClaims.sensitive,
          recordedAt: vaultClaims.recordedAt,
        })
        .from(vaultClaims)
        .where(and(inArray(vaultClaims.id, predecessorIds), eq(vaultClaims.spaceId, spaceId)))
    : [];

  const facts: FactView[] = page.map((f) => {
    const prev = f.supersedes ? predecessors.find((p) => p.id === f.supersedes) : undefined;
    return {
      id: f.id,
      revision: f.revision,
      // The owner's own fact, in full, paired with the advisory the page blurs on —
      // see `StatementView` for why the two travel together and the module comment
      // for why this is not the same question the manifest answers.
      statement: { text: f.statement, sensitive: f.sensitive },
      recordedAt: f.recordedAt.toISOString(),
      source: sourceOf(evidenceRows.filter((e) => e.claimId === f.id), f.origin),
      trust: trustTagOf(f.sourceClass, f.origin),
      previous: prev
        ? { statement: { text: prev.statement, sensitive: prev.sensitive }, at: prev.recordedAt.toISOString() }
        : null,
    };
  });
  // Both counts off the sets they name, neither off `facts`: the cap is the reason
  // `matched` is worth sending, and the search is the reason `total` is.
  return { facts, matched: matched.length, total: heads.length };
}

/**
 * THE ONE READER OF CONFLICT STATE, and it returns BOTH statements (§9.1).
 *
 * `conflicts_with` is written by §4.5 step 5 — a correction that may not supersede is
 * stored live at its own class pointing at the fact it contests, and the target row is
 * untouched. Two readers with different predicates was already a recorded near-miss in
 * this feature (the confirm path read `policy_state` while the page read the evidence
 * column, so a person authorised a replacement and got a second head contradicting the
 * first, in every later prompt, forever). So there is one function, it serves the card
 * and the fact list alike, and the fact list makes no conflict decision of its own —
 * which is what leaves nothing for a second predicate to disagree with.
 *
 * BOTH statements, not a flag. A person cannot choose between two facts against one they
 * cannot see, and both sides carry their own `sensitive` and their own trust tag because
 * both are their own row: `confirmClaim` raises a flag in place, and the contesting row
 * is by definition at a different class from the one it contests.
 *
 * FOUR conditions, and each one is a rule this surface already holds:
 *   - the space, so a pointer can only ever be read inside the space that owns it;
 *   - `conflicts_with IS NOT NULL`, which is the state itself;
 *   - both rows LIVE (`superseded_at IS NULL`) — quoting a dead predecessor as the thing
 *     this would replace misdescribes the choice being asked for;
 *   - no `review_status` clause, for the reason the module docstring gives.
 */
export async function readConflicts(spaceId: string): Promise<ConflictView[]> {
  const contesting = db.$with("contesting").as(
    db
      .select({
        id: vaultClaims.id,
        revision: vaultClaims.revision,
        statement: vaultClaims.statement,
        sensitive: vaultClaims.sensitive,
        sourceClass: vaultClaims.sourceClass,
        origin: vaultClaims.origin,
        recordedAt: vaultClaims.recordedAt,
        conflictsWith: vaultClaims.conflictsWith,
      })
      .from(vaultClaims)
      .where(
        and(
          eq(vaultClaims.spaceId, spaceId),
          isNull(vaultClaims.supersededAt),
          isNotNull(vaultClaims.conflictsWith),
        ),
      ),
  );
  // A self-join rather than two round trips: the pair is the unit, and a second query
  // would be a second chance for the two halves to be read under different predicates.
  const target = alias(vaultClaims, "target");
  const rows = await db
    .with(contesting)
    .select({
      id: contesting.id,
      revision: contesting.revision,
      statement: contesting.statement,
      sensitive: contesting.sensitive,
      sourceClass: contesting.sourceClass,
      origin: contesting.origin,
      recordedAt: contesting.recordedAt,
      otherId: target.id,
      otherRevision: target.revision,
      otherStatement: target.statement,
      otherSensitive: target.sensitive,
      otherSourceClass: target.sourceClass,
      otherOrigin: target.origin,
      otherRecordedAt: target.recordedAt,
    })
    .from(contesting)
    .innerJoin(
      target,
      and(eq(target.id, contesting.conflictsWith), eq(target.spaceId, spaceId), isNull(target.supersededAt)),
    )
    .orderBy(desc(contesting.recordedAt), asc(contesting.id));

  return rows.map((r) => ({
    claim: {
      id: r.id,
      revision: r.revision,
      statement: { text: r.statement, sensitive: r.sensitive },
      trust: trustTagOf(r.sourceClass, r.origin),
      at: r.recordedAt.toISOString(),
    },
    contested: {
      id: r.otherId,
      revision: r.otherRevision,
      statement: { text: r.otherStatement, sensitive: r.otherSensitive },
      trust: trustTagOf(r.otherSourceClass, r.otherOrigin),
      at: r.otherRecordedAt.toISOString(),
    },
  }));
}

/** What the retired review queue still holds, oldest first (a person reads it from the
 *  start). Read-only: the archive expires with its table (§11.8).
 *
 *  `denied` is excluded — the user said they did not want that material, and listing it
 *  would put it back on the screen it was refused from. `auto_active` is excluded
 *  because it was never a question. */
async function archiveOf(spaceId: string, userId: string): Promise<ArchivedView[]> {
  const rows = await db
    .select({
      id: memoryCandidates.id,
      statement: memoryCandidates.statement,
      sensitive: memoryCandidates.sensitive,
      createdAt: memoryCandidates.createdAt,
      policyState: memoryCandidates.policyState,
      conflictsWith: memoryCandidates.conflictsWith,
      chatId: chats.id,
      chatTitle: chats.title,
      at: messages.createdAt,
    })
    .from(memoryCandidates)
    .leftJoin(messages, eq(messages.id, memoryCandidates.originMessageId))
    .leftJoin(chats, and(eq(chats.id, messages.chatId), eq(chats.userId, userId)))
    .where(
      and(
        eq(memoryCandidates.spaceId, spaceId),
        isNull(memoryCandidates.resolvedAt),
        inArray(memoryCandidates.policyState, ["pending", "conflict"]),
      ),
    )
    .orderBy(asc(memoryCandidates.createdAt), asc(memoryCandidates.id));

  // The other half of an archived conflict, in one statement. TWO filters now, and the
  // third one's removal is the same change the fact list above got: `review_status =
  // 'confirmed'` used to be here so the archive could not name a claim the page refused
  // to list, and nothing is refused any more.
  //   - the space, because `memory_candidates.conflicts_with` carries no foreign key
  //     (unlike `vault_claims`', which is composite — round-2 N11);
  //   - `superseded_at IS NULL`, because quoting a dead predecessor as the thing this
  //     would replace misdescribes the choice being asked for.
  // `sensitive` is selected because `StatementView` carries it; nothing here reads it.
  const contestedIds = rows.map((r) => r.conflictsWith).filter((v): v is string => !!v);
  const contested = contestedIds.length
    ? await db
        .select({
          id: vaultClaims.id,
          statement: vaultClaims.statement,
          sensitive: vaultClaims.sensitive,
          recordedAt: vaultClaims.recordedAt,
        })
        .from(vaultClaims)
        .where(
          and(
            inArray(vaultClaims.id, contestedIds),
            eq(vaultClaims.spaceId, spaceId),
            isNull(vaultClaims.supersededAt),
          ),
        )
    : [];

  return rows.map((r) => {
    const other = r.conflictsWith ? contested.find((c) => c.id === r.conflictsWith) : undefined;
    return {
      id: r.id,
      // The owner's own words to decide on. A sensitive row is marked, not withheld —
      // see the module comment: confirming what the screen refuses to show is not a
      // decision anyone can make.
      statement: { text: r.statement, sensitive: r.sensitive },
      createdAt: (r.createdAt ?? new Date(0)).toISOString(),
      state: r.policyState === "conflict" ? "conflict" : "pending",
      source: sourceOf([{ chatId: r.chatId, chatTitle: r.chatTitle, at: r.at }], null),
      conflictsWith: other
        ? { statement: { text: other.statement, sensitive: other.sensitive }, at: other.recordedAt.toISOString() }
        : null,
    };
  });
}

/**
 * The whole page for one person, optionally narrowed to a search.
 *
 * `query` narrows the FACTS and nothing else. The conflicts are decisions a person still
 * has to take and the archive is on a deadline; both are short by construction, and
 * hiding a row out of either behind a search box would be a way to lose it — so they come
 * back whole whatever is typed.
 */
export async function readMemoryPage(
  userId: string,
  query = "",
): Promise<{ scopes: ScopeView[]; archiveExpiresAt: string }> {
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.userId, userId), projectNotDeleted))
    .orderBy(projects.name);

  // Every space this user owns that is still live. Filtered on `owner_user_id` AND on
  // `retired_at`: a retired project space is a tombstone whose content is already gone,
  // and listing it would show an empty scope for a project the user deleted. Nothing
  // here creates a space — opening the page must not conjure one for a person who has
  // never recorded a fact.
  const spaceRows = await db
    .select({ id: spaces.id, type: spaces.type, refId: spaces.refId })
    .from(spaces)
    .where(
      and(
        eq(spaces.ownerUserId, userId),
        isNull(spaces.retiredAt),
        inArray(spaces.refId, [userId, ...projectRows.map((p) => p.id)]),
      ),
    );

  const scopes: ScopeView[] = [];
  const userSpace = spaceRows.find((s) => s.type === "user" && s.refId === userId);
  const own = userSpace ? await factsOf(userSpace.id, userId, query) : { facts: [], matched: 0, total: 0 };
  scopes.push({
    scope: "user",
    facts: own.facts,
    factsMatched: own.matched,
    factsTotal: own.total,
    conflicts: userSpace ? await readConflicts(userSpace.id) : [],
    archive: userSpace ? await archiveOf(userSpace.id, userId) : [],
  });
  for (const p of projectRows) {
    const space = spaceRows.find((s) => s.type === "project" && s.refId === p.id);
    if (!space) continue;
    const [found, conflicts, archive] = await Promise.all([
      factsOf(space.id, userId, query),
      readConflicts(space.id),
      archiveOf(space.id, userId),
    ]);
    // Dropped on the UNFILTERED total, not on the match count: a project section is a
    // heading, and a heading over nothing is noise — but a search that matched nothing in
    // this project has not emptied the project, and making its whole section vanish while
    // the reader types is how a person concludes a project's memory was lost.
    if (!found.total && !archive.length) continue;
    scopes.push({
      scope: "project", projectId: p.id, projectName: p.name,
      facts: found.facts, factsMatched: found.matched, factsTotal: found.total, conflicts, archive,
    });
  }
  // ON THE RESPONSE rather than in the component, because the component is a client
  // bundle and this module opens a database connection at import. It is one date for the
  // whole page — the archive expires as a TABLE, not row by row — so it rides beside the
  // scopes instead of being repeated on every archived row.
  return { scopes, archiveExpiresAt: archiveExpiresAt() };
}
