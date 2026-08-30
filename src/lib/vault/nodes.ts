import { and, eq, isNull, or } from "drizzle-orm";
import { vaultEdges, vaultNodes } from "@/lib/db/schema";
import type { Ex } from "./spaces";

export type NodeKind = "note" | "claim" | "source";

/**
 * THE writer of a `vault_nodes` row, and it takes an `ex` with no default on purpose:
 * a node row exists only as half of a subtype write, so there is no such thing as
 * creating one outside somebody else's transaction.
 *
 * Three call sites, which is why this is a function rather than three inline inserts:
 * `createClaim`, `updateClaim`'s successor, and `getOrCreateTopicNote`. A fourth — the
 * source writer that arrives with file ingestion in slice 3 — is not optional, and it is
 * the composite FK added in migration `00NN` that will say so at the insert rather than
 * at review.
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
 * TWO sites in the whole system hard-delete a node row, and this is neither of them:
 * the `spaces` cascade fired by `purgeUserSpaces`, hard because the space itself is
 * going; and `getOrCreateTopicNote`'s race-loser rollback in `spaces.ts`, hard because
 * the node is two statements old, has no edges and lost its note to a concurrent
 * creator — a tombstone for a note that never existed would be worse than no row.
 * Anywhere ELSE a hard node delete fires `vault_edges`' `on delete cascade` and
 * hard-deletes edges, which is exactly what §2.4 forbids. Read those two as the closed
 * enumeration; a third would be a defect.
 *
 * Idempotent by predicate: both writes are guarded on `deleted_at IS NULL`, so a
 * re-driven forget re-timestamps nothing.
 */
export async function deleteNode(nodeId: string, spaceId: string, ex: Ex): Promise<void> {
  const now = new Date();
  await ex
    .update(vaultNodes)
    .set({ deletedAt: now })
    .where(and(eq(vaultNodes.id, nodeId), eq(vaultNodes.spaceId, spaceId), isNull(vaultNodes.deletedAt)));
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
  return { nodes: nodes.length };
}
