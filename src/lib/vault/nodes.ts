import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { vaultEdges, vaultNodes } from "@/lib/db/schema";
import { unprojectNode, unprojectSpace } from "./search-documents";
import type { Ex } from "./spaces";

export type NodeKind = "note" | "claim" | "source";

/**
 * THE writer of a `vault_nodes` row, and it takes an `ex` with no default on purpose:
 * a node row exists only as half of a subtype write, so there is no such thing as
 * creating one outside somebody else's transaction.
 *
 * It is a function rather than an inline insert at each writer because the PROPERTY has to
 * hold at all of them and a count does not: a node row is never inserted except as half of
 * a subtype write, in that write's own transaction. Counting them was a maintenance trap —
 * this docstring said "three: `createClaim`, `updateClaim`'s successor and
 * `getOrCreateTopicNote`" and slice 2 replaced the third with `resolveTopic` before adding
 * `createNote` beside it.
 * The source writer that arrives with file ingestion in slice 3 is the one still doing
 * work here: it is not optional, and it is the composite FK added in migration `0060` that
 * will say so at the insert rather than at review.
 *
 * `createdAt` is settable so a backfill can carry the subtype row's own timestamp; live
 * writers omit it.
 */
export async function insertNode(
  args: { id: string; spaceId: string; kind: NodeKind; createdAt?: Date },
  ex: Ex,
): Promise<void> {
  await ex.insert(vaultNodes).values({
    id: args.id,
    spaceId: args.spaceId,
    kind: args.kind,
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  });
}

/**
 * THE inverse of `insertNode`, and it lives here because the registration does: a node's
 * soft delete and the cascade of its live edges are one act, and a caller that ran the
 * first without the second would leave edges pointing at a row every reader hides.
 *
 * Soft, not hard, EVERYWHERE. An edge is soft-deleted so the graph can still explain a
 * tombstone (§2.4). A node is soft-deleted because the subtype services disagree about
 * what "deleted" means for their own rows — `retireProjectSpace` hard-DELETEs claims and
 * notes but SOFT-deletes sources — and a hard node delete would raise 23503 against the
 * source rows that deliberately survive.
 *
 * ONE site in the whole system hard-deletes a node row, and this is not it: the `spaces`
 * cascade fired by `purgeUserSpaces`, hard because the space itself is going.
 *
 * There were two. `resolveTopic`'s race loser used to hard-delete the node whose note had
 * just lost the title index, and the argument for it was that a tombstone for a note that
 * never existed would be worse than no row. That is still true and no longer needs a
 * DELETE: the node and the note go in under one SAVEPOINT, so the loser rolls both back
 * together. A hard delete that is not the space cascade would fire `vault_edges`'
 * `on delete cascade` and hard-delete edges, which is exactly what §2.4 forbids — read the
 * one as the closed enumeration; a second would be a defect.
 *
 * Idempotent by predicate: both writes are guarded on `deleted_at IS NULL`, so a
 * re-driven forget re-timestamps nothing.
 *
 * `onlyIf` IS AN EXTRA CONDITION ON THE NODE UPDATE'S OWN `WHERE`, and it exists for
 * `memory_forget`'s same-task bound (§4.9): the bound is a column comparison IN THE DB WRITE,
 * not a check the caller makes first, because reachability is not authority and this repo's
 * history says a rule enforced at one entrance grows a second. When it is passed and the
 * update matches nothing, THE CASCADE DOES NOT RUN and this returns `false` — the caller
 * wrote nothing at all. Without it the cascade is unconditional, which is the existing
 * contract and the reason a re-driven forget still closes edges the first one somehow left.
 *
 * The condition itself is built by the module that owns the columns it names — a note's
 * same-task bound lives on the HEAD VERSION, which is `notes.ts`' business — so what arrives
 * here is SQL and not a table this module would otherwise import.
 *
 * THE EDGE HALF NOW MOVES REAL ROWS. Until §11.5's dual-write, `vault_edges` was empty in
 * every live space and this update was a statement nothing had yet exercised outside a
 * seeded fixture; `claims.ts` now writes a `contains` edge beside every `note_claims` row,
 * so forgetting one fact closes the edge that filed it. The `note_claims` row deliberately
 * stays — "forgetting a fact does not mean rewriting where it came from" — which is why
 * `containsParity` compares only LIVE nodes: the two tables disagree about a forgotten
 * claim on purpose, and a control that read that as a divergence would fire on ordinary
 * use.
 */
export async function deleteNode(
  nodeId: string,
  spaceId: string,
  ex: Ex,
  opts?: { onlyIf: SQL },
): Promise<boolean> {
  const now = new Date();
  const closed = await ex
    .update(vaultNodes)
    .set({ deletedAt: now })
    .where(
      and(
        eq(vaultNodes.id, nodeId),
        eq(vaultNodes.spaceId, spaceId),
        isNull(vaultNodes.deletedAt),
        ...(opts ? [opts.onlyIf] : []),
      ),
    )
    .returning({ id: vaultNodes.id });
  // A GUARDED delete that matched nothing wrote nothing, so nothing is cascaded either. An
  // UNGUARDED one falls through whatever it matched, which is the contract every existing
  // caller has: it is called beside a supersede that already moved the row.
  if (opts && !closed.length) return false;
  // Both directions: the walk is undirected, so "the edges of this node" is not a
  // one-sided question, and a `contains` edge points AT a claim while a `derived_from`
  // edge points FROM one.
  await ex
    .update(vaultEdges)
    .set({ deletedAt: now })
    .where(
      and(
        eq(vaultEdges.spaceId, spaceId),
        isNull(vaultEdges.deletedAt),
        or(eq(vaultEdges.fromNodeId, nodeId), eq(vaultEdges.toNodeId, nodeId)),
      ),
    );
  // The projection is deleted by the same transaction that deletes the row it projects -
  // including the node SOFT delete, which is the entrance a "delete the row" rule written
  // against `vault_claims` alone would miss, and which no foreign key can see.
  await unprojectNode(nodeId, spaceId, ex);
  return true;
}

/**
 * THE INVERSE OF `deleteNode`, and it lives here for the same reason that one does: putting
 * a node back and reopening the edges the delete closed are one act.
 *
 * IT TAKES THE TIMESTAMP, and that parameter is the whole design. `deleteNode` stamps the
 * node and its live edges with one `now`, so "the edges this delete closed" is exactly the
 * set carrying that value — and an edge closed by some EARLIER act (a supersede, a fact the
 * person forgot last month) carries a different one and correctly stays closed. An
 * un-timestamped restore would have to reopen every edge of the node, which is how an undo
 * resurrects relationships nobody asked to have back.
 *
 * WHY THE EDGES MUST COME BACK AT ALL, since `resolveTopic`'s revive arm deliberately does
 * not bring them: `containsParity` compares `note_claims` against LIVE `contains` edges,
 * scoped to LIVE nodes. While the topic's node is a tombstone the pair is out of scope and
 * agrees; the moment the node is live again with its edges still closed, every fact filed
 * under it reads as "only in note_claims" — and `assertContainsParity` throws inside the
 * next `contains` write anywhere in that space, outside production. So a restore that
 * skipped this would not merely lose a relationship, it would poison the next write.
 *
 * `false` when nothing matched: the node is already live, or it is not in this space. A
 * caller that reported that as a failure would tell a person their undo broke for a row
 * that is exactly where they wanted it.
 *
 * THE PROJECTION IS THE CALLER'S HALF, which is the one asymmetry with `deleteNode` —
 * `unprojectNode` is kind-blind and the two re-projectors are not (`projectNoteDoc`,
 * `projectClaimDoc`), so a switch here would be this module deciding a question the
 * subtype services own. `resolveTopic`'s revive arm already sets that precedent: it clears
 * the tombstone and calls `projectNoteDoc` itself.
 */
export async function restoreNode(
  nodeId: string,
  spaceId: string,
  deletedAt: Date,
  ex: Ex,
): Promise<boolean> {
  const reopened = await ex
    .update(vaultNodes)
    .set({ deletedAt: null })
    .where(and(eq(vaultNodes.id, nodeId), eq(vaultNodes.spaceId, spaceId), eq(vaultNodes.deletedAt, deletedAt)))
    .returning({ id: vaultNodes.id });
  if (!reopened.length) return false;
  await ex
    .update(vaultEdges)
    .set({ deletedAt: null })
    .where(
      and(
        eq(vaultEdges.spaceId, spaceId),
        eq(vaultEdges.deletedAt, deletedAt),
        or(eq(vaultEdges.fromNodeId, nodeId), eq(vaultEdges.toNodeId, nodeId)),
      ),
    );
  return true;
}

/**
 * The same inverse for a WHOLE SPACE, set-based. `retireProjectSpace` is its only caller.
 *
 * It is a second function rather than a loop over `deleteNode` because a project's space
 * holds every claim, note and document the person ever filed there, and a round trip per
 * node would scale with exactly the thing that makes someone delete a project. It is a
 * second function in THIS MODULE rather than three statements in `spaces.ts` because the
 * node registry owns its own inverse — that is the whole reason `deleteNode` is not a
 * `db.update` at each of its call sites either.
 *
 * It returns the count so `retireProjectSpace`'s audit payload can say what it removed.
 */
export async function deleteSpaceNodes(spaceId: string, ex: Ex): Promise<{ nodes: number }> {
  const now = new Date();
  const nodes = await ex
    .update(vaultNodes)
    .set({ deletedAt: now })
    .where(and(eq(vaultNodes.spaceId, spaceId), isNull(vaultNodes.deletedAt)))
    .returning({ id: vaultNodes.id });
  await ex
    .update(vaultEdges)
    .set({ deletedAt: now })
    .where(and(eq(vaultEdges.spaceId, spaceId), isNull(vaultEdges.deletedAt)));
  // Same obligation, set-based. NOT left to a cascade: `retireProjectSpace` keeps the
  // `spaces` row as a tombstone, so `vault_search_documents.space_id`'s cascade never
  // fires for a retired project, and Ruling 10's soft node delete does not fire the node
  // FK's cascade either. Two cascades that both look like they cover this and neither
  // does — which is why the deletion goes through the owning module instead.
  await unprojectSpace(spaceId, ex);
  return { nodes: nodes.length };
}
