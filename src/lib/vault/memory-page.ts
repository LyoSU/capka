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
 * WHAT THIS SURFACE MAY SHOW, and why it differs from every other reader of a claim's
 * text. There are FOUR, enumerated by what reaches the DATA rather than by who calls
 * `listHeadClaims` — that accessor-shaped enumeration is what hid the fourth one from a
 * whole re-review, because `mismatch` reads through `findCurrentHead` instead:
 *
 *   - `manifest.ts` — non-sensitive statement; a sensitive one withheld entirely, not
 *     even counted in its topic's counter.
 *   - `memory_search` (`tools.ts`) — statement plus `[id@revision]`; a sensitive one
 *     withheld behind a query-independent aggregate count.
 *   - `mismatch` (`tools.ts`, the lost-CAS reply of memory_update/memory_forget) —
 *     statement, and withheld for a sensitive head, or a lost CAS would be a second way
 *     to read out what the manifest hides.
 *   - THIS ONE — a sensitive fact's EXISTENCE: its topic, its date, and (from Task 2)
 *     its delete control. Never its text.
 *
 * That last row is what closes the dead end recorded on `memory_forget`: the claim
 * becomes reachable by a HUMAN, by address, without anyone ever learning the words. It
 * does not weaken the provenance gate, because the person clicking is not the model.
 *
 * `review_status` is filtered to `confirmed` for the FACTS. An unverified claim is
 * quarantined material and belongs in the waiting list below, not in the list of what
 * the assistant is using — the same rule the other three readers hold.
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
  /** `null` for a sensitive fact: the page says one exists, never what it says. */
  statement: string | null;
  sensitive: boolean;
  recordedAt: string;
  source: FactSource;
  /** The immediately previous version. Never populated for a sensitive fact — it is the
   *  same withheld words, one revision earlier. */
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
  statement: string | null;
  sensitive: boolean;
  createdAt: string;
  state: "pending" | "conflict";
  source: FactSource;
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
          // The whole withholding rule for this surface, in one place. A sensitive
          // fact's TEXT never leaves the server here — not in `statement`, and not in
          // `previous`, which is the same words one revision earlier.
          statement: f.sensitive ? null : f.statement,
          sensitive: f.sensitive,
          recordedAt: f.recordedAt.toISOString(),
          source: sourceOf(evidenceRows.filter((e) => e.claimId === f.id), f.origin),
          previous: !f.sensitive && prev ? { statement: prev.statement, at: prev.recordedAt.toISOString() } : null,
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

  return rows.map((r) => ({
    id: r.id,
    // A sensitive CANDIDATE withholds its text on the same rule as a sensitive head. It
    // can still be confirmed or rejected by address once Task 8 ships those controls.
    statement: r.sensitive ? null : r.statement,
    sensitive: r.sensitive,
    createdAt: (r.createdAt ?? new Date(0)).toISOString(),
    state: r.policyState === "conflict" ? "conflict" : "pending",
    source: sourceOf([{ chatId: r.chatId, chatTitle: r.chatTitle, at: r.at }], null),
  }));
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
