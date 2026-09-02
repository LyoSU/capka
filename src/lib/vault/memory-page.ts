import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  chats, claimEvidence, memoryCandidates, messages, projects, spaces, vaultClaims,
} from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
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
 * `review_status` is filtered to `confirmed` for the FACTS. An unverified claim is
 * quarantined material and belongs in the waiting list below, not in the list of what
 * the assistant is using — the same rule the model-facing readers hold.
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

export type FactView = {
  id: string;
  revision: number;
  statement: StatementView;
  recordedAt: string;
  source: FactSource;
  /** The immediately previous version. Carries its OWN sensitivity, which is not
   *  derivable from the successor's: `confirmClaim` raises a head's flag in place with no
   *  supersede, so a non-sensitive fact really can hold a predecessor that has since
   *  become sensitive. */
  previous: FactHistory | null;
};

export type PendingView = {
  id: string;
  statement: StatementView;
  createdAt: string;
  state: "pending" | "conflict";
  source: FactSource;
  /** For a row in `conflict`: the head it is contested against. Keeping this one
   *  supersedes that one, and a person cannot make that choice against a fact they
   *  cannot see. `null` on a plain pending row, and also on the conflict the ledger
   *  records with no head to point at (the slot was contested and then vacated). */
  conflictsWith: FactHistory | null;
};

export type ScopeView = {
  scope: "user" | "project";
  projectId?: string;
  projectName?: string;
  /** Every confirmed live head in the space, newest first — matching the search when
   *  there is one, and never more than `FACT_LIMIT` of them. */
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
  pending: PendingView[];
};

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
    return (origin as { kind?: string } | null)?.kind === "legacy_memory_doc"
      ? { kind: "legacy" }
      : { kind: "unknown" };
  }
  named.sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = { chatId: named[0].chatId, chatTitle: named[0].chatTitle, at: named[0].at.toISOString() };
  const distinct = new Set(named.map((r) => r.chatId)).size;
  return distinct === 1 ? { kind: "chat", ...latest } : { kind: "chats", count: distinct, latest };
}

/**
 * ONE list of a scope's facts — every confirmed live head in the space, newest first.
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
    })
    .from(vaultClaims)
    .where(
      and(
        eq(vaultClaims.spaceId, spaceId),
        isNull(vaultClaims.supersededAt),
        eq(vaultClaims.reviewStatus, "confirmed"),
      ),
    )
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
      previous: prev
        ? { statement: { text: prev.statement, sensitive: prev.sensitive }, at: prev.recordedAt.toISOString() }
        : null,
    };
  });
  // Both counts off the sets they name, neither off `facts`: the cap is the reason
  // `matched` is worth sending, and the search is the reason `total` is.
  return { facts, matched: matched.length, total: heads.length };
}

/** What is waiting for the person: everything they still have to decide, oldest first
 *  (they work through it from the start).
 *
 *  `denied` is excluded — the user said they did not want that material, and listing it
 *  would put it back on the screen it was refused from. `auto_active` is excluded
 *  because it was never a question. */
async function pendingOf(spaceId: string, userId: string): Promise<PendingView[]> {
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

  // The other half of every conflict, in one statement. Three filters, and each one is a
  // rule this surface already holds elsewhere:
  //   - the space, because `conflicts_with` carries no foreign key;
  //   - `superseded_at IS NULL`, because quoting a dead predecessor as the thing this
  //     would replace misdescribes the choice being asked for;
  //   - `review_status = 'confirmed'`, the same quarantine rule `topicsOf` holds. The
  //     head is taken from `headBySlot`/`listHeadClaims`, neither of which filters review
  //     status, so without this the page names a claim it refuses to list anywhere else.
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
            eq(vaultClaims.reviewStatus, "confirmed"),
          ),
        )
    : [];

  return rows.map((r) => {
    const other = r.conflictsWith ? contested.find((c) => c.id === r.conflictsWith) : undefined;
    return {
      id: r.id,
      // The owner's own words to decide on. A sensitive candidate is marked, not
      // withheld — see the module comment: confirming what the screen refuses to show
      // is not a decision anyone can make.
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
 * `query` narrows the FACTS and nothing else. The review queue is what a person still has
 * to decide, it is short by construction, and hiding rows out of it behind a search box
 * would be a way to lose a decision — so it comes back whole whatever is typed.
 */
export async function readMemoryPage(userId: string, query = ""): Promise<{ scopes: ScopeView[] }> {
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
    pending: userSpace ? await pendingOf(userSpace.id, userId) : [],
  });
  for (const p of projectRows) {
    const space = spaceRows.find((s) => s.type === "project" && s.refId === p.id);
    if (!space) continue;
    const [found, pending] = await Promise.all([factsOf(space.id, userId, query), pendingOf(space.id, userId)]);
    // Dropped on the UNFILTERED total, not on the match count: a project section is a
    // heading, and a heading over nothing is noise — but a search that matched nothing in
    // this project has not emptied the project, and making its whole section vanish while
    // the reader types is how a person concludes a project's memory was lost.
    if (!found.total && !pending.length) continue;
    scopes.push({
      scope: "project", projectId: p.id, projectName: p.name,
      facts: found.facts, factsMatched: found.matched, factsTotal: found.total, pending,
    });
  }
  return { scopes };
}
