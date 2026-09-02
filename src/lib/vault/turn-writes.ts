import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents, spaces, vaultClaims, vaultNodes, vaultNotes, vaultNoteVersions } from "@/lib/db/schema";

/**
 * WHAT A TURN WROTE TO MEMORY — the data behind the chat's "saved to memory" notice.
 *
 * A PROJECTION, NOT A STORED BLOB, and that is the whole shape of it. The notice could
 * have been a `metadata` key on the assistant message: the runner knows what it wrote, and
 * writing a list there is one line. It would also be a SECOND record of the same facts,
 * kept in a column snapshots replace wholesale, going stale the moment the person deletes
 * one of the rows it names — a notice offering Undo on a fact that is already gone. So the
 * source of truth stays the one it always was, and this module reads it back.
 *
 * THE KEY IS THE MESSAGE, and it is reached through the subtype row rather than through
 * the event. `audit_events` has no message column — its addressing is `subject_id` — while
 * a claim's `origin` and a note version's `provenance` both record the turn that wrote
 * them. So the join goes event → row → `messageId`, which is also what makes the two halves
 * one query shape rather than two mechanisms.
 *
 * WHY THE EVENT IS IN THE JOIN AT ALL, since the subtype row carries the message id by
 * itself: the event is what says the row was CREATED by this turn rather than merely
 * touched by it. A supersede writes `claim.supersede` and a fresh row whose `origin` names
 * the same message, and "Capka remembered 2 things" for one correction is a miscount a
 * person notices immediately. `claim.create` and `note.revise` are the two actions §2.11
 * gives to a write that put new words in the store.
 *
 * LIVE ROWS ONLY. An item the person has already undone is not in the list on the next
 * read, which is what makes the notice's own Undo idempotent without any client state: the
 * button removes the row, the next load of the chat no longer names it, and there is no
 * second place holding a copy that says otherwise.
 *
 * AND "LIVE" IS THE NODE'S FLAG, not only the subtype's. §2.10 keeps three lifecycle
 * columns apart and a note has no `superseded_at` at all: `forgetNote` soft-deletes the
 * `vault_nodes` row and cascades its edges, leaving `vault_notes` exactly as it was. Reading
 * only the subtype tables passed the claim half and kept naming a note the person had just
 * undone — with an Undo button beside it that then answered 404. So both halves join
 * `vault_nodes`, which is the one flag that means "gone from every list".
 *
 * OWNERSHIP is the space's, checked here and not assumed. The caller is a chat route that
 * has already proved the chat is this user's, but a fact's space is a different object from
 * a chat, and a shared or imported chat is exactly the case where those two diverge.
 */
export type TurnWriteKind = "fact" | "note";

export type TurnWrite = {
  /** The row's id, which is also the id the undo route takes. `handle`-free on purpose:
   *  a run-local handle is minted for a model and expires with the turn, and this is the
   *  person's own page acting on their own row. */
  id: string;
  kind: TurnWriteKind;
  /** What was saved, as one line. A note sends its TITLE — the body is a document, and a
   *  notice is not where a person reads one. */
  text: string;
  /** Marked, never withheld: this is the owner reading their own chat, and the notice
   *  blurs the words exactly as the memory page does. */
  sensitive: boolean;
  /** Which scope it landed in, so "you told Capka X" and "this project pays in EUR" are
   *  not the same sentence. `null` for a space that is somehow neither, which cannot
   *  happen today and is not worth a throw in a display path. */
  scope: "user" | "project" | null;
};

/** Keyed by the message the turn wrote — one entry per assistant row that saved anything,
 *  and NO entry for one that saved nothing (which is what "says nothing at all when a turn
 *  wrote nothing" means at this layer: the map has no key, so the renderer has no data and
 *  renders no element). */
export type TurnWrites = Record<string, TurnWrite[]>;

export async function readTurnWrites(messageIds: string[], userId: string): Promise<TurnWrites> {
  if (!messageIds.length) return {};

  const owned = and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt));

  // The two halves are two statements rather than a union, because the subtype tables have
  // different shapes and a union would have to flatten them into a lowest common set of
  // columns — which is how a note's title and a claim's statement end up in one nullable
  // column that neither owns.
  const facts = await db
    .select({
      messageId: sql<string>`${vaultClaims.origin} ->> 'messageId'`,
      id: vaultClaims.id,
      text: vaultClaims.statement,
      sensitive: vaultClaims.sensitive,
      spaceType: spaces.type,
      at: auditEvents.createdAt,
    })
    .from(auditEvents)
    .innerJoin(vaultClaims, eq(vaultClaims.id, auditEvents.subjectId))
    .innerJoin(vaultNodes, and(eq(vaultNodes.id, vaultClaims.id), isNull(vaultNodes.deletedAt)))
    .innerJoin(spaces, eq(spaces.id, vaultClaims.spaceId))
    .where(
      and(
        eq(auditEvents.action, "claim.create"),
        owned,
        // BOTH flags for a claim, and they are not the same question: `superseded_at`
        // says this row is not the fact any more (a correction replaced it), while the
        // node's tombstone says the fact is gone. A supersede leaves the node alone —
        // history is not deleted — so neither clause implies the other.
        isNull(vaultClaims.supersededAt),
        inArray(sql`${vaultClaims.origin} ->> 'messageId'`, messageIds),
      ),
    );

  const notes = await db
    .select({
      messageId: sql<string>`${vaultNoteVersions.provenance} ->> 'messageId'`,
      id: vaultNotes.id,
      text: vaultNoteVersions.title,
      sensitive: vaultNoteVersions.sensitive,
      spaceType: spaces.type,
      at: auditEvents.createdAt,
    })
    .from(auditEvents)
    .innerJoin(vaultNotes, eq(vaultNotes.id, auditEvents.subjectId))
    // The HEAD version, joined on the integer rather than on `current_version_id`: the
    // pointer is legitimately NULL for a statement or two inside both note writers, and a
    // reader that joined on it would answer "no such note" for a note that exists.
    .innerJoin(
      vaultNoteVersions,
      and(
        eq(vaultNoteVersions.noteId, vaultNotes.id),
        eq(vaultNoteVersions.revision, vaultNotes.currentRevision),
      ),
    )
    .innerJoin(vaultNodes, and(eq(vaultNodes.id, vaultNotes.id), isNull(vaultNodes.deletedAt)))
    .innerJoin(spaces, eq(spaces.id, vaultNotes.spaceId))
    .where(
      and(
        eq(auditEvents.action, "note.revise"),
        owned,
        inArray(sql`${vaultNoteVersions.provenance} ->> 'messageId'`, messageIds),
      ),
    );

  const out: TurnWrites = {};
  // One list per message, ordered by when the write happened, facts and notes interleaved
  // — the turn wrote them in some order and the notice reads better in it than grouped by
  // kind, which would suggest the two are different sections of something.
  const rows = [
    ...facts.map((r) => ({ ...r, kind: "fact" as const })),
    ...notes.map((r) => ({ ...r, kind: "note" as const })),
  ].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  for (const r of rows) {
    // A note revised twice in one turn has two `note.revise` events pointing at one note,
    // and the notice must name it once: the person has one row to undo, not two.
    const list = (out[r.messageId] ??= []);
    if (list.some((w) => w.id === r.id)) continue;
    list.push({
      id: r.id,
      kind: r.kind,
      text: r.text,
      sensitive: r.sensitive,
      scope: r.spaceType === "user" || r.spaceType === "project" ? r.spaceType : null,
    });
  }
  return out;
}
