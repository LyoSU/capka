import { vaultNodes } from "@/lib/db/schema";
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
