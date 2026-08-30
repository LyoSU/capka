import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  chats, claimEvidence, memoryCandidates, messages, noteClaims, projects, spaces, vaultClaims, vaultNotes,
} from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";

/**
 * Everything the memory page shows, assembled server-side.
 *
 * The point of this module is what the page it replaces threw away. Three relations are
 * already populated and were all projected out by rendering memory as markdown:
 * `note_claims` groups facts into topics, `claim_evidence.message_id` records the
 * conversation a fact came from, and `vault_claims.supersedes` records what it replaced.
 * None of it is new work; the page simply stopped discarding it.
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
 *   - `mismatch` (`tools.ts`, the lost-CAS reply of memory_update/memory_forget) —
 *     statement, and withheld for a sensitive head, or a lost CAS would be a second way
 *     to read out what the manifest hides.
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

export type FactHistory = { statement: string; at: string };

export type FactView = {
  id: string;
  revision: number;
  statement: string;
  /** Advisory, and what the page renders the blur-and-reveal from. It is not a
   *  withholding on this wire — see the module comment. */
  sensitive: boolean;
  recordedAt: string;
  source: FactSource;
  /** The immediately previous version. */
  previous: FactHistory | null;
};

export type TopicView = {
  id: string;
  /** The stable identity. The UI localizes it; nothing joins on the title. */
  topicKey: string | null;
  /** The stored seed title — the fallback display for a key the UI has no copy for. */
  title: string;
  lastUpdatedAt: string | null;
  facts: FactView[];
};

export type PendingView = {
  id: string;
  statement: string;
  /** Advisory, exactly as on a fact. */
  sensitive: boolean;
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
  topics: TopicView[];
  pending: PendingView[];
};

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

/** One space's topics with their facts, provenance and one step of history.
 *
 *  Four statements, not N+1: the topics, their memberships joined to the confirmed
 *  heads, every evidence row for those heads with its chat, and every immediate
 *  predecessor. A per-fact query would be a round-trip per fact on a page whose whole
 *  purpose is to show all of them at once. */
async function topicsOf(spaceId: string, userId: string): Promise<TopicView[]> {
  const noteRows = await db
    .select({ id: vaultNotes.id, topicKey: vaultNotes.topicKey, title: vaultNotes.title })
    .from(vaultNotes)
    .where(and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.kind, "memory_topic")))
    .orderBy(asc(vaultNotes.title));
  if (!noteRows.length) return [];

  const factRows = await db
    .select({
      noteId: noteClaims.noteId,
      id: vaultClaims.id,
      revision: vaultClaims.revision,
      statement: vaultClaims.statement,
      sensitive: vaultClaims.sensitive,
      recordedAt: vaultClaims.recordedAt,
      supersedes: vaultClaims.supersedes,
      origin: vaultClaims.origin,
    })
    .from(noteClaims)
    .innerJoin(vaultClaims, eq(vaultClaims.id, noteClaims.claimId))
    .where(
      and(
        inArray(noteClaims.noteId, noteRows.map((n) => n.id)),
        eq(vaultClaims.spaceId, spaceId),
        isNull(vaultClaims.supersededAt),
        eq(vaultClaims.reviewStatus, "confirmed"),
      ),
    )
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));

  const factIds = factRows.map((f) => f.id);
  const evidenceRows = factIds.length
    ? await db
        .select({ claimId: claimEvidence.claimId, chatId: chats.id, chatTitle: chats.title, at: messages.createdAt })
        .from(claimEvidence)
        .leftJoin(messages, eq(messages.id, claimEvidence.messageId))
        .leftJoin(chats, and(eq(chats.id, messages.chatId), eq(chats.userId, userId)))
        .where(inArray(claimEvidence.claimId, factIds))
    : [];

  const predecessorIds = factRows.map((f) => f.supersedes).filter((v): v is string => !!v);
  const predecessors = predecessorIds.length
    ? await db
        .select({ id: vaultClaims.id, statement: vaultClaims.statement, recordedAt: vaultClaims.recordedAt })
        .from(vaultClaims)
        .where(and(inArray(vaultClaims.id, predecessorIds), eq(vaultClaims.spaceId, spaceId)))
    : [];

  return noteRows.map((note) => {
    const facts: FactView[] = factRows
      .filter((f) => f.noteId === note.id)
      .map((f) => {
        const prev = f.supersedes ? predecessors.find((p) => p.id === f.supersedes) : undefined;
        return {
          id: f.id,
          revision: f.revision,
          // The owner's own fact, in full. `sensitive` rides alongside as the advisory
          // the page blurs on — see the module comment for why this is not the same
          // question the manifest answers.
          statement: f.statement,
          sensitive: f.sensitive,
          recordedAt: f.recordedAt.toISOString(),
          source: sourceOf(evidenceRows.filter((e) => e.claimId === f.id), f.origin),
          previous: prev ? { statement: prev.statement, at: prev.recordedAt.toISOString() } : null,
        };
      });
    return {
      id: note.id,
      topicKey: note.topicKey,
      title: note.title,
      // Derived from the CLAIMS, never from `vault_notes.updated_at`: nothing in this
      // codebase writes that column after insert, so it would report the day the topic
      // was created and call it the day the topic changed.
      lastUpdatedAt: facts.length ? facts[0].recordedAt : null,
      facts,
    };
  });
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

  // The other half of every conflict, in one statement. Scoped to THIS space and to a
  // live head: `conflicts_with` carries no foreign key, so a head that has since been
  // forgotten or superseded leaves an id pointing at nothing — and a stale predecessor
  // shown as "this replaces that" would misdescribe the very choice being asked for.
  const contestedIds = rows.map((r) => r.conflictsWith).filter((v): v is string => !!v);
  const contested = contestedIds.length
    ? await db
        .select({ id: vaultClaims.id, statement: vaultClaims.statement, recordedAt: vaultClaims.recordedAt })
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
      // The owner's own words to decide on. A sensitive candidate is marked, not
      // withheld — see the module comment: confirming what the screen refuses to show
      // is not a decision anyone can make.
      statement: r.statement,
      sensitive: r.sensitive,
      createdAt: (r.createdAt ?? new Date(0)).toISOString(),
      state: r.policyState === "conflict" ? "conflict" : "pending",
      source: sourceOf([{ chatId: r.chatId, chatTitle: r.chatTitle, at: r.at }], null),
      conflictsWith: other ? { statement: other.statement, at: other.recordedAt.toISOString() } : null,
    };
  });
}

export async function readMemoryPage(userId: string): Promise<{ scopes: ScopeView[] }> {
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
  scopes.push({
    scope: "user",
    topics: userSpace ? await topicsOf(userSpace.id, userId) : [],
    pending: userSpace ? await pendingOf(userSpace.id, userId) : [],
  });
  for (const p of projectRows) {
    const space = spaceRows.find((s) => s.type === "project" && s.refId === p.id);
    if (!space) continue;
    const [topics, pending] = await Promise.all([topicsOf(space.id, userId), pendingOf(space.id, userId)]);
    if (!topics.length && !pending.length) continue;
    scopes.push({ scope: "project", projectId: p.id, projectName: p.name, topics, pending });
  }
  return { scopes };
}
