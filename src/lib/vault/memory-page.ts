import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  chats, claimEvidence, memoryCandidates, messages, noteClaims, projects, spaces, vaultClaims,
  vaultNodes, vaultNotes, vaultNoteVersions,
} from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import type { SourceClass } from "./claims";
import { renderBody } from "./links";
// The tuple lives in its own import-free module because the PAGE needs it as a value, and
// this module opens a database connection at import — see `memory-sections.ts`.
import { TOPIC_SECTIONS, type TopicSection } from "./memory-sections";

/**
 * Everything the memory page shows, assembled server-side.
 *
 * The point of this module is what the page it replaces threw away. Two relations are
 * already populated and were both projected out by rendering memory as markdown:
 * `claim_evidence.message_id` records the conversation a fact came from, and
 * `vault_claims.supersedes` records what it replaced. Neither is new work; the page simply
 * stopped discarding them.
 *
 * A third, `note_claims`, files a fact under a topic, and it is read again — see
 * `topicsOf`. It was dropped for one release, and the reason it was dropped is worth
 * keeping: the RAIL it fed was a filing system nothing filed into, so selecting one topic
 * at a time put 33 of this account's 51 facts on screen and left 18 behind buttons nobody
 * had a reason to press. What changed is not that the filing got better — it is that the
 * page no longer leads with facts at all. The unit on the screen is a TOPIC FILE, the facts
 * are a disclosure inside one, and a fact filed under nothing has its own list
 * (`unfiled`) rather than no home. That is what keeps §11.9 true — every fact the agent
 * writes stays visible, editable and deletable here — under a page whose top level is
 * topics.
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

/**
 * ONE TOPIC FILE, which is what this page is now a list of.
 *
 * IT IS A NOTE, of either kind, and that is a decision worth stating because the shape of
 * the page depends on it. `memory_topic` is the container `resolveTopic` mints while filing
 * a fact — a title, a `topic_key`, and a body the agent may later write into; `note` is what
 * `memory_note_write` creates. Both are a title plus a markdown body plus a revision
 * history, which is the whole of what a "topic file" is, so listing one kind and not the
 * other would leave the other invisible on the only surface a person can delete it from.
 * That is the §11.9 failure this page exists to prevent, arrived at from the filing side
 * rather than the fact side.
 *
 * THE TEXTS TRAVEL AS `StatementView`s for the reason that type gives: `sensitive` has one
 * reader in this codebase and a title dropped straight into JSX is how it grows a second.
 * All three carry the HEAD REVISION's flag, because that is whose words they are.
 */
export type TopicView = {
  id: string;
  section: TopicSection;
  /** The head revision, so the delete route and a later editor can address it. */
  revision: number;
  title: StatementView;
  /** The body's first non-heading, non-empty paragraph, markdown stripped — see
   *  `firstParagraph`. Empty for a topic container nothing has written into yet, and the
   *  row then simply has no second line. */
  preview: StatementView;
  /** The whole body, with every canonical edge token already resolved to its target's
   *  current title (`renderBody`). The detail view hands this to the app's markdown
   *  renderer. */
  body: StatementView;
  /** The HEAD REVISION's `created_at` — "Updated <day>". Not `vault_notes.updated_at`,
   *  which the note CAS also touches for a filing that changed no words. */
  updatedAt: string;
  trust: TrustTag;
  /** The facts filed under this topic (`note_claims`), newest first, capped at
   *  `FACT_LIMIT`. Read through the membership table and not through `vault_edges`: the
   *  membership row survives the owner's delete of this topic, which is what makes the
   *  undo lossless. */
  facts: FactView[];
  /** How many are filed here at all, before the cap. */
  factsTotal: number;
};

export type ScopeView = {
  scope: "user" | "project";
  projectId?: string;
  projectName?: string;
  /** Every live topic file in the space, grouped by the page and sorted by title inside
   *  each group — which is the order this array already carries. */
  topics: TopicView[];
  /** LIVE HEADS FILED UNDER NO LIVE TOPIC, newest first, capped like a topic's own list.
   *
   *  It is not a theoretical arm: `runExtraction` and `migrateMemoryDocs` both call
   *  `createClaim` with no `topicNoteId`, so an unattended extraction produces exactly
   *  these rows. Today the count is zero — every one of this account's 51 live facts is
   *  filed — and a list that renders nothing is the correct cost of the guarantee: without
   *  it, "every fact the agent writes stays visible" would be a property of which writer
   *  happened to run rather than of this page. */
  unfiled: FactView[];
  /** How many facts hang off no live topic at all, before the cap — the same disclosure
   *  `TopicView.factsTotal` carries, for the list that can grow without anybody filing
   *  anything. `unfiled.length` cannot stand in for it: that length IS the cap, so the
   *  "showing some of many" sentence could never fire for this list. */
  unfiledTotal: number;
  /** How many facts the scope holds at all. Its one reader is the "forget everything"
   *  dialog, which promises to forget everything and so cannot state a number narrowed by
   *  anything — including by which topic a fact is filed under. */
  factsTotal: number;
  /** Facts that disagree with each other, from the ONE reader of that state
   *  (`readConflicts`). Both halves also appear under their topic — they are live heads,
   *  and nothing decides visibility on this page — so the card is a second VIEW of them
   *  and not a filter over the lists, which is what keeps a second predicate from
   *  existing. */
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
 * How many facts ONE TOPIC'S disclosure sends to the browser.
 *
 * At today's 51 across five topics it does nothing, and that is the point: the shape has to
 * survive 5000 without anybody rewriting this module, and an unbounded list is the thing
 * that would have to be rewritten. The cap is PER TOPIC and not per scope, which is the
 * one detail worth stating: a space-wide cap over facts ordered by date would fill its
 * window with whatever was saved last week and show a quiet topic's list as empty while its
 * heading claimed twelve — a count and a list that disagree, in the one place a person goes
 * to check what is remembered. Per topic they cannot disagree, and the extra cost is zero
 * (the same two follow-up statements run over the union of the slices).
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
 * told the assistant — the same words the page itself uses for it, rather than the product
 * name. That is a display equivalence, not a class equivalence: the two are still
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
 * THE ROW'S SECOND LINE: the body's first paragraph, as plain text.
 *
 * A pure exported function beside `sourceOf` and `trustTagOf`, for the reason those two
 * are: this repo's vitest runs with `environment: "node"` and has no React renderer, so a
 * transformation done inside a component cannot be tested at all — and the skip rules
 * below are exactly the kind of thing that rots silently.
 *
 * WHAT IT SKIPS, and why each one is a skip rather than a strip:
 *
 *   - a HEADING (`# …`, and a `Summary` / `Details` line the reference writes INSIDE the
 *     file's own content). A preview reading "Summary" tells the reader nothing they did
 *     not already get from the title, and every file the agent is being steered to write
 *     opens with one. A hash RUN FOLLOWED BY A SPACE, per CommonMark — a leading `#` alone
 *     is a hashtag or "#1 priority", which is prose.
 *   - a FENCE (```): its first line is a language tag or nothing.
 *   - a block that is NOTHING BUT A LINK — a canonical edge token already resolved to
 *     `[[Some title]]`, or `[[link removed]]` when its target is gone. Neither is prose,
 *     and the second one as a preview would describe the page's own plumbing.
 *
 * Everything else is a paragraph, INCLUDING a list: a file whose body is a heading and
 * five bullets is common, and "no preview" reads as an empty file rather than a full one.
 * The marker is stripped and the first item stands in.
 *
 * IT DOES NOT TRUNCATE. The row does that in CSS, so the clip lands at the column's real
 * width in the reader's own font — a JS slice at N characters is either short of the line
 * or spilling out of it, and it is wrong differently in every locale.
 */
export function firstParagraph(bodyMarkdown: string): string {
  for (const raw of bodyMarkdown.split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    // A HASH RUN FOLLOWED BY A SPACE, per CommonMark — not merely a leading `#`. "#1
    // priority is the invoice" is a sentence, and skipping it showed the reader whatever
    // came next as if the file opened with a heading it does not have.
    if (/^#{1,6}\s/.test(block) || block.startsWith("```")) continue;
    // A block that is NOTHING BUT link tokens is skipped whole, which has to happen before
    // the strip below turns one into its own label — otherwise a file opening with a link
    // block previews as the linked note's title, or as "link removed" when the target is
    // gone, and either reads as this file's own first sentence.
    if (!block.replace(/\[\[[^\]]*\]\]/g, "").trim()) continue;
    // Inline markdown out, in the order that keeps a nested construct readable: link and
    // image targets first (so the label survives), then wiki-style link brackets, then
    // emphasis and code ticks, then the leading block markers of the first line.
    const flat = block
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[\[([^\]]*)\]\]/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!flat) continue;
    return flat;
  }
  return "";
}

/** The live claim heads of one space, newest first — the read every list on this page is a
 *  slice of.
 *
 *  HEAD + SCOPE, and nothing else (§11.9). No `review_status`, no `prompt_access`: the
 *  first is history and the second withholds from the MODEL, never from the person whose
 *  space this is.
 *
 *  ORDERING is `recorded_at` descending. The `id` tiebreak is not decorative —
 *  `recorded_at` is identical across every claim one transaction wrote, and a list that
 *  reshuffles between two loads of the same page is one a person cannot re-find a row in. */
function headRows(spaceId: string) {
  return db
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
    .where(and(eq(vaultClaims.spaceId, spaceId), isNull(vaultClaims.supersededAt)))
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
}

type HeadRow = Awaited<ReturnType<typeof headRows>>[number];

/**
 * HEAD ROWS -> `FactView`s: the provenance and the predecessor, in two statements for the
 * whole set however many lists it is about to be split across.
 *
 * It takes the ALREADY-CAPPED union of every list on the page rather than a space's whole
 * history, which is what keeps a 5000-fact space from fanning out into two 5000-row joins
 * to render a few hundred rows. Called ONCE per space for that reason: a per-topic call
 * would be the N+1 the cap exists to avoid, and a fact filed under two topics would be
 * hydrated twice.
 */
async function hydrateFacts(spaceId: string, userId: string, heads: HeadRow[]): Promise<Map<string, FactView>> {
  const out = new Map<string, FactView>();
  if (!heads.length) return out;
  const factIds = heads.map((f) => f.id);
  const evidenceRows = await db
    .select({ claimId: claimEvidence.claimId, chatId: chats.id, chatTitle: chats.title, at: messages.createdAt })
    .from(claimEvidence)
    .leftJoin(messages, eq(messages.id, claimEvidence.messageId))
    .leftJoin(chats, and(eq(chats.id, messages.chatId), eq(chats.userId, userId)))
    .where(inArray(claimEvidence.claimId, factIds));

  const predecessorIds = heads.map((f) => f.supersedes).filter((v): v is string => !!v);
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

  for (const f of heads) {
    const prev = f.supersedes ? predecessors.find((p) => p.id === f.supersedes) : undefined;
    out.set(f.id, {
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
    });
  }
  return out;
}

/**
 * A SCOPE'S TOPIC FILES, the facts under each, and the facts under none.
 *
 * LIVE NOTES, of both kinds, joined to their HEAD VERSION — see `TopicView` for why the
 * kind is not filtered. The one thing the kind decides is EMPTINESS: a `memory_topic`
 * container with no prose and no facts is dropped, which is the same `count > 0` reasoning
 * `listManifestTopics` applies to the manifest, arrived at from the page's side. Every
 * `memory_note_write` naming a topic mints such a container, so listing them all puts a
 * title-and-a-date row beside every file the person actually got. A plain `note` is never
 * dropped: an empty one is a file somebody made and is the only surface it can be deleted
 * from, and a container that holds anything at all still has a row to open.
 *
 * Head-ness is `revision = current_revision` and never the
 * `current_version_id` pointer, for the reason that column's own docstring gives: the
 * pointer is legitimately NULL for a statement or two inside both note writers, and a
 * reader that joined on it would answer "no such note" for a note that exists.
 *
 * THE TOMBSTONE IS ON THE NODE, so the liveness clause is a join to `vault_nodes` and not
 * a column on `vault_notes` — the same asymmetry `forgetNote` documents: a note's identity
 * row is never deleted, its NODE is.
 *
 * FIVE STATEMENTS plus one small read per topic that actually contains a link, whatever the
 * space holds: the heads, the notes, the membership, then evidence and predecessors over
 * the union of the CAPPED slices. `renderBody` costs nothing at all for a body with no
 * canonical edge token in it, which is every body in this account today.
 *
 * ORDERED BY (section, title), which is the order the page renders and therefore the order
 * this array carries: a component that re-sorted would be a second answer to "what comes
 * first". `localeCompare` with no locale argument, because the server does not know the
 * reader's — and a topic list is short enough that the collation difference between
 * `en` and `uk` moves nothing a person is looking for.
 */
async function topicsOf(
  spaceId: string,
  userId: string,
): Promise<{ topics: TopicView[]; unfiled: FactView[]; unfiledTotal: number; factsTotal: number }> {
  const heads = await headRows(spaceId);
  const noteRows = await db
    .select({
      id: vaultNotes.id,
      kind: vaultNotes.kind,
      section: vaultNotes.section,
      revision: vaultNotes.currentRevision,
      title: vaultNoteVersions.title,
      bodyMarkdown: vaultNoteVersions.bodyMarkdown,
      sensitive: vaultNoteVersions.sensitive,
      sourceClass: vaultNoteVersions.sourceClass,
      provenance: vaultNoteVersions.provenance,
      createdAt: vaultNoteVersions.createdAt,
    })
    .from(vaultNotes)
    .innerJoin(
      vaultNoteVersions,
      and(eq(vaultNoteVersions.noteId, vaultNotes.id), eq(vaultNoteVersions.revision, vaultNotes.currentRevision)),
    )
    .innerJoin(vaultNodes, and(eq(vaultNodes.id, vaultNotes.id), eq(vaultNodes.spaceId, vaultNotes.spaceId)))
    .where(and(eq(vaultNotes.spaceId, spaceId), isNull(vaultNodes.deletedAt)));

  // WHICH FACT IS FILED WHERE, from the membership table and not from `vault_edges`. The
  // two are dual-written (§11.5) and agree by construction, so this is a choice and worth
  // one sentence: `deleteNode` soft-deletes a topic's edges and leaves its `note_claims`
  // rows alone, so reading the membership is what makes the owner's delete-and-undo of a
  // topic lossless — the facts come back filed where they were, with no edge to reopen on
  // a path that would otherwise have to know about them.
  const noteIds = noteRows.map((n) => n.id);
  const membership = noteIds.length
    ? await db
        .select({ noteId: noteClaims.noteId, claimId: noteClaims.claimId })
        .from(noteClaims)
        .where(inArray(noteClaims.noteId, noteIds))
    : [];
  const filedUnder = new Map<string, HeadRow[]>(noteIds.map((id) => [id, []]));
  const anyTopic = new Set<string>();
  const byId = new Map(heads.map((h) => [h.id, h]));
  for (const m of membership) {
    const head = byId.get(m.claimId);
    if (!head) continue; // superseded or forgotten: `note_claims` keeps the row on purpose
    filedUnder.get(m.noteId)?.push(head);
    anyTopic.add(head.id);
  }

  // The cap, per list, BEFORE anything is hydrated — see `FACT_LIMIT`.
  const slices = new Map([...filedUnder].map(([id, rows]) => [id, rows.slice(0, FACT_LIMIT)]));
  const looseRows = heads.filter((h) => !anyTopic.has(h.id));
  const unfiledRows = looseRows.slice(0, FACT_LIMIT);
  const union = [...new Set([...slices.values()].flat().concat(unfiledRows))];
  const hydrated = await hydrateFacts(spaceId, userId, union);
  const viewsOf = (rows: HeadRow[]) => rows.map((r) => hydrated.get(r.id)).filter((v): v is FactView => !!v);

  const topics: TopicView[] = [];
  for (const n of noteRows) {
    const body = await renderBody(n.bodyMarkdown, spaceId);
    const factsTotal = filedUnder.get(n.id)?.length ?? 0;
    // The emptiness gate, measured on the RENDERED body rather than the stored markdown —
    // what the reader would see is what decides whether there is a row worth opening. A
    // container holding only a token therefore keeps its row: the token renders as the
    // removed-link text, which is content, and the row is where a person deletes the file.
    // See the docstring for why only a container is droppable at all.
    if (n.kind === "memory_topic" && !body.trim() && !factsTotal) continue;
    topics.push({
      id: n.id,
      section: n.section,
      revision: n.revision,
      title: { text: n.title, sensitive: n.sensitive },
      preview: { text: firstParagraph(body), sensitive: n.sensitive },
      body: { text: body, sensitive: n.sensitive },
      updatedAt: n.createdAt.toISOString(),
      trust: trustTagOf(n.sourceClass, n.provenance),
      facts: viewsOf(slices.get(n.id) ?? []),
      factsTotal,
    });
  }
  const order = (s: TopicSection) => TOPIC_SECTIONS.indexOf(s);
  topics.sort((a, b) => order(a.section) - order(b.section) || a.title.text.localeCompare(b.title.text));

  return {
    topics,
    unfiled: viewsOf(unfiledRows),
    unfiledTotal: looseRows.length,
    factsTotal: heads.length,
  };
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
 * The whole page for one person.
 *
 * IT TAKES NO SEARCH, and the search it used to take is deleted rather than hidden. That
 * box filtered a flat list of every fact in the space, which was the only navigation the
 * page had; the page's top level is now a short list of topic FILES, one per subject, and
 * a person finds a subject by reading four headings. A search box over a list of five rows
 * is a control that answers a question nobody has, and — the reason it could not simply
 * stay — the copy under it said grouping by subject "isn't available yet", which the
 * sections now make false on the same screen.
 */
export async function readMemoryPage(
  userId: string,
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
  const own = userSpace
    ? await topicsOf(userSpace.id, userId)
    : { topics: [], unfiled: [], unfiledTotal: 0, factsTotal: 0 };
  scopes.push({
    scope: "user",
    topics: own.topics,
    unfiled: own.unfiled,
    unfiledTotal: own.unfiledTotal,
    factsTotal: own.factsTotal,
    conflicts: userSpace ? await readConflicts(userSpace.id) : [],
    archive: userSpace ? await archiveOf(userSpace.id, userId) : [],
  });
  for (const p of projectRows) {
    const space = spaceRows.find((s) => s.type === "project" && s.refId === p.id);
    if (!space) continue;
    const [found, conflicts, archive] = await Promise.all([
      topicsOf(space.id, userId),
      readConflicts(space.id),
      archiveOf(space.id, userId),
    ]);
    // A project sub-group is a heading, and a heading over nothing is noise. It appears the
    // moment the project's memory holds anything at all — a topic file, a fact filed under
    // none, or a leftover suggestion — because each of those is something a person may
    // want to delete, and a scope that renders nothing is a scope they cannot reach.
    if (!found.topics.length && !found.factsTotal && !archive.length) continue;
    scopes.push({
      scope: "project", projectId: p.id, projectName: p.name,
      topics: found.topics, unfiled: found.unfiled, unfiledTotal: found.unfiledTotal,
      factsTotal: found.factsTotal, conflicts, archive,
    });
  }
  // ON THE RESPONSE rather than in the component, because the component is a client
  // bundle and this module opens a database connection at import. It is one date for the
  // whole page — the archive expires as a TABLE, not row by row — so it rides beside the
  // scopes instead of being repeated on every archived row.
  return { scopes, archiveExpiresAt: archiveExpiresAt() };
}
