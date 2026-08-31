import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { vaultClaims, vaultNodes, vaultNotes, vaultSearchDocuments } from "@/lib/db/schema";
import type { Ex } from "./spaces";

/**
 * THE projection's writers and its inverse, in one module, because "written by the same
 * transaction that writes the row it projects, and deleted by the same transaction that
 * deletes it" is a pair of obligations and splitting them across two files is how one of
 * them gets forgotten.
 *
 * WHAT MODEL_TEXT IS: the redacted projection. For a claim it is the statement unless the
 * row is sensitive, in which case it is NULL. Owner surfaces read `owner_text`, which
 * always has it.
 *
 * Say what that does and does not buy, plainly, because the shorter version ("a withheld
 * unit has no model-facing text at all") is FALSE of the table: `model_tsv` is
 * `to_tsvector('simple', title || ' ' || coalesce(model_text,''))`, so a withheld row's
 * TITLE is still matchable in the model FTS lane, while the trigram lane
 * (`norm_model_text`) drops the title entirely. The two model-lane columns disagree about
 * whether a title is model-facing. THE MODEL-FACING GATE IS NOT THIS COLUMN — it is the
 * mints' join to the authoritative row, where `prompt_access` and the liveness predicate
 * decide what is returned (Tasks 10/11). A NULL here narrows the candidate set early; it
 * does not authorize anything, and no reader may treat it as the gate.
 *
 * THE TITLE DECISION, made here rather than left implicit: a claim is projected with
 * `title: ""`, always. A claim is the only kind that can be withheld, so no writer in this
 * module can produce the one shape that disagreement would leak through — a withheld row
 * carrying owner-only text in `title`. If a future kind is both titled and withholdable,
 * that title has to be withheld with the body, or the FTS lane hands it out.
 *
 * These functions take an `ex` with no default, like `insertNode`: a projection write is
 * half of somebody else's transaction and there is no such thing as doing it alone.
 * `rebuildSearchDocuments` is the exception - it is the repair, and it owns its own
 * transaction.
 */

const upsert = async (
  row: {
    spaceId: string;
    nodeId: string;
    kind: "claim" | "note";
    title: string;
    ownerText: string;
    modelText: string | null;
  },
  ex: Ex,
): Promise<void> => {
  await ex
    .insert(vaultSearchDocuments)
    // `fragmentId` takes its `''` default; a claim or a note is not a fragment.
    .values({ id: nanoid(), ...row })
    // The unit key, not the primary key: a re-projection of one node must replace its row
    // rather than mint a second one, and `uniq_vsearch_unit` is what that key IS.
    //
    // Three plain COLUMNS, which is all drizzle-orm 0.45.2 accepts here: the conflict
    // target is typed `IndexColumn | IndexColumn[]` where `IndexColumn = PgColumn`
    // (`pg-core/query-builders/insert.d.ts:139`, `pg-core/indexes.d.ts:34`), and drizzle
    // renders it as a column-name list — so an `SQL` chunk neither typechecks nor emits
    // the ON CONFLICT list that would match the index.
    .onConflictDoUpdate({
      target: [vaultSearchDocuments.spaceId, vaultSearchDocuments.nodeId, vaultSearchDocuments.fragmentId],
      set: {
        kind: row.kind,
        title: row.title,
        ownerText: row.ownerText,
        modelText: row.modelText,
        updatedAt: new Date(),
      },
    });
};

/** Project one claim head. Reads the row back rather than taking the caller's values: the
 *  secret screen may have RAISED `sensitive` inside `createClaim`, and a caller projecting
 *  what it asked for would index text the row does not consider showable. */
export async function projectClaimDoc(claimId: string, ex: Ex): Promise<void> {
  const [row] = await ex
    .select({
      spaceId: vaultClaims.spaceId,
      statement: vaultClaims.statement,
      slotKey: vaultClaims.slotKey,
      sensitive: vaultClaims.sensitive,
    })
    .from(vaultClaims)
    .where(eq(vaultClaims.id, claimId))
    .limit(1);
  if (!row) return;
  // The slot key is searchable text on the owner side - `memory_search` matches it today -
  // and it is NOT model-facing on its own: it rides the model channel only as part of a
  // statement the mint already admitted. The memory page's search box is NOT a second
  // reason: it filters `norm(h.statement)` in JavaScript (`memory-page.ts`) and never looks
  // at `slotKey`. That claim used to stand here as half the justification for this
  // concatenation, and it was never true.
  const ownerText = row.slotKey ? `${row.statement} ${row.slotKey}` : row.statement;
  await upsert(
    {
      spaceId: row.spaceId,
      nodeId: claimId,
      kind: "claim",
      // EMPTY, and load-bearing: `model_tsv` includes `title` while `norm_model_text` does
      // not, so a withheld claim with a title would be matchable in one model lane and not
      // the other. A claim has no title of its own; keeping it `''` is what makes that
      // disagreement unreachable. See the module docstring.
      title: "",
      ownerText,
      modelText: row.sensitive ? null : ownerText,
    },
    ex,
  );
}

/** Project one note. Its body is a compatibility column until slice 2's versions land;
 *  the title is what the manifest and the memory page both search on today. */
export async function projectNoteDoc(noteId: string, ex: Ex): Promise<void> {
  const [row] = await ex
    .select({ spaceId: vaultNotes.spaceId, title: vaultNotes.title, body: vaultNotes.body })
    .from(vaultNotes)
    .where(eq(vaultNotes.id, noteId))
    .limit(1);
  if (!row) return;
  await upsert(
    {
      spaceId: row.spaceId,
      nodeId: noteId,
      kind: "note",
      title: row.title,
      ownerText: row.body,
      // Notes carry no class of their own until slice 2's versions, so nothing here is
      // withheld. The mint's note arm is what decides visibility, and it reads
      // `vault_notes`, not this row.
      modelText: row.body,
    },
    ex,
  );
}

/** THE inverse, called from `deleteNode` so that "the projection is deleted by the same
 *  transaction that deletes the row it projects" holds for every node kind at once. */
export async function unprojectNode(nodeId: string, spaceId: string, ex: Ex): Promise<void> {
  await ex
    .delete(vaultSearchDocuments)
    .where(and(eq(vaultSearchDocuments.spaceId, spaceId), eq(vaultSearchDocuments.nodeId, nodeId)));
}

/**
 * The same inverse for a WHOLE SPACE, called from `deleteSpaceNodes`.
 *
 * It exists because the obvious reason it should not need to exist is FALSE.
 * `vault_search_documents.space_id` does cascade from `spaces` — but
 * `retireProjectSpace` never deletes the `spaces` row: it deliberately keeps a tombstone
 * (`spaces.ts`, "The space row also stays"), because `ref_id` is polymorphic and
 * `spaceAcceptsWrites` needs something to read. And under Ruling 10 the node rows are
 * soft-deleted, so the node FK's cascade does not fire either. With neither cascade
 * running, every claim statement and note body from a deleted project would sit in a
 * full-text- and trigram-indexed table indefinitely, with the mints' join to the (now
 * absent) subtype row as the only thing between it and a reader.
 *
 * A deletion the user performed must not depend on a cascade nobody checked. This is the
 * explicit call.
 */
export async function unprojectSpace(spaceId: string, ex: Ex): Promise<void> {
  await ex.delete(vaultSearchDocuments).where(eq(vaultSearchDocuments.spaceId, spaceId));
}

/**
 * THE repair, and the boot backfill. A rebuild nobody can run is the same defect as no
 * rebuild (L7), so this is exposed as an admin route as well.
 *
 * Idempotent and a pure function of the subtype tables - which is the property that makes
 * the projection safe to hold no lifecycle state: if it is ever wrong, it is throwable
 * away. It rebuilds ONE space per call, so an operator can repair a space without a
 * whole-instance job.
 *
 * ACCEPTED, and recorded rather than discovered: this loops one round trip per claim and
 * per note, while the boot migration (`drizzle/0064`) does the same mapping set-based in
 * SQL. Two implementations of one mapping is exactly this repo's recurring defect.
 *
 * WHAT THE REBUILD TEST ACTUALLY PROVES, since this docstring used to claim more. Its
 * fixture rows are written by the TS writers and then compared against what THIS function
 * writes - both sides are the same TS mapping, so it proves that mapping self-consistent
 * (a rebuild reproduces a live projection row for row) and says NOTHING about the SQL
 * copy. What covers the SQL copy is a different, one-shot fact: it was compared against
 * the live data at migration time, and being a migration it cannot run a second time, so
 * it has no later chance to diverge. `0064`'s own header still credits the test with more
 * than that; it is an applied migration and its comment stays as written.
 *
 * If a third producer ever appears, collapse them; do not add it.
 */
export async function rebuildSearchDocuments(spaceId: string, ex?: Ex): Promise<{ written: number }> {
  if (!ex || ex === db) return db.transaction((tx) => rebuildSearchDocuments(spaceId, tx));
  await ex.delete(vaultSearchDocuments).where(eq(vaultSearchDocuments.spaceId, spaceId));
  const claims = await ex
    .select({ id: vaultClaims.id })
    .from(vaultClaims)
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultClaims.id))
    .where(and(eq(vaultClaims.spaceId, spaceId), isNull(vaultNodes.deletedAt)));
  for (const c of claims) await projectClaimDoc(c.id, ex);
  const notes = await ex
    .select({ id: vaultNotes.id })
    .from(vaultNotes)
    .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
    .where(and(eq(vaultNotes.spaceId, spaceId), isNull(vaultNodes.deletedAt)));
  for (const n of notes) await projectNoteDoc(n.id, ex);
  return { written: claims.length + notes.length };
}
