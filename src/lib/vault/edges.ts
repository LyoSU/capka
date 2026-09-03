import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { spaces as spacesTable, vaultEdges, vaultNodes } from "@/lib/db/schema";
import { log } from "@/lib/log";
// Type-only, both of them, so nothing travels back at runtime: `claims.ts` imports this
// module for its value exports, and a runtime import in the other direction would be a
// cycle. `Actor` lives in `claims.ts` because that is where the audit log spells it.
import type { Actor } from "./claims";
import type { NodeKind } from "./nodes";
import type { Ex } from "./spaces";

export type Relation = "contains" | "references" | "derived_from";

/**
 * THE `vault_edges` writers and their inverses, in one module, because a registration and
 * the thing that undoes it belong together.
 *
 * THE LEGAL PAIRS ARE ENFORCED HERE, not by the schema: `check (relation in (...))` bounds
 * the vocabulary, and a composite FK bounds the space, but "a `contains` edge runs topic ->
 * note|claim" is a statement about two rows' KINDS and no CHECK can see across rows. So it
 * is one function, and every writer goes through it.
 *
 *   contains     note (topic) -> note | claim
 *   references   note         -> note | claim | source
 *   derived_from note | claim -> source
 *
 * SOFT DELETE ONLY. An edge is never hard-deleted, so the graph can still explain a
 * tombstone; the `on delete cascade` on both FKs fires only for the one hard node delete
 * `nodes.ts` enumerates.
 */
const LEGAL: Record<Relation, { from: NodeKind[]; to: NodeKind[] }> = {
  contains: { from: ["note"], to: ["note", "claim"] },
  references: { from: ["note"], to: ["note", "claim", "source"] },
  derived_from: { from: ["note", "claim"], to: ["source"] },
};

/**
 * Takes an `ex` with no default, for the same reason `insertNode` does: an edge is written
 * beside the membership row it mirrors, and there is no such thing as linking two nodes
 * outside the transaction that made them members.
 *
 * Idempotent through `uniq_live_vault_edge` rather than through a read-then-write, so two
 * concurrent writers cannot both see "no edge" and both insert. `onConflictDoNothing` and
 * not a caught 23505: a raised unique violation poisons the caller's whole transaction,
 * and every caller here is mid-move with rows already written — the topic fold learned
 * that one at the cost of a SAVEPOINT (`resolveTopic`), and this site does not need the
 * SAVEPOINT because it never raises.
 */
export async function linkNodes(
  a: {
    spaceId: string;
    from: string;
    to: string;
    relation: Relation;
    createdBy: Actor;
    position?: number;
    originMessageId?: string;
  },
  ex: Ex,
): Promise<{ id: string; created: boolean }> {
  // Both kinds in ONE read, so the pair check cannot see two moments.
  const kinds = await ex
    .select({ id: vaultNodes.id, kind: vaultNodes.kind })
    .from(vaultNodes)
    .where(
      and(
        eq(vaultNodes.spaceId, a.spaceId),
        inArray(vaultNodes.id, [a.from, a.to]),
        isNull(vaultNodes.deletedAt),
      ),
    );
  const from = kinds.find((k) => k.id === a.from);
  const to = kinds.find((k) => k.id === a.to);
  if (!from || !to) throw new Error(`edge endpoint not found in space ${a.spaceId}`);
  const legal = LEGAL[a.relation];
  if (!legal.from.includes(from.kind) || !legal.to.includes(to.kind)) {
    throw new Error(`relation ${a.relation} does not run ${from.kind} -> ${to.kind}`);
  }
  const id = nanoid();
  const ins = await ex
    .insert(vaultEdges)
    .values({
      id,
      spaceId: a.spaceId,
      fromNodeId: a.from,
      toNodeId: a.to,
      relation: a.relation,
      position: a.position ?? 0,
      createdBy: a.createdBy,
      originMessageId: a.originMessageId ?? null,
    })
    .onConflictDoNothing() // uniq_live_vault_edge
    .returning({ id: vaultEdges.id });
  if (ins.length) return { id, created: true };
  const [live] = await ex
    .select({ id: vaultEdges.id })
    .from(vaultEdges)
    .where(
      and(
        eq(vaultEdges.spaceId, a.spaceId),
        eq(vaultEdges.fromNodeId, a.from),
        eq(vaultEdges.toNodeId, a.to),
        eq(vaultEdges.relation, a.relation),
        isNull(vaultEdges.deletedAt),
      ),
    )
    .limit(1);
  if (!live) throw new Error(`edge ${a.from}->${a.to} vanished after insert`);
  return { id: live.id, created: false };
}

/**
 * THE inverse of `linkNodes` for ONE edge the caller already holds the id of.
 *
 * Soft, and guarded on `deleted_at IS NULL` so a re-driven unlink re-timestamps nothing —
 * the same idempotency `deleteNode` carries, for the same reason: a tombstone must record
 * when the link was cut, not when the sweep last ran.
 *
 * Returns whether it cut a live edge, so a caller can tell "closed it" from "there was
 * nothing to close" without a second read.
 */
export async function unlinkEdge(edgeId: string, spaceId: string, ex: Ex): Promise<boolean> {
  const closed = await ex
    .update(vaultEdges)
    .set({ deletedAt: new Date() })
    .where(and(eq(vaultEdges.id, edgeId), eq(vaultEdges.spaceId, spaceId), isNull(vaultEdges.deletedAt)))
    .returning({ id: vaultEdges.id });
  return closed.length > 0;
}

/**
 * The same inverse for the SET of `contains` edges that point at one claim, and it is a
 * second function rather than a loop over `unlinkEdge` for the reason `deleteSpaceNodes`
 * is a second function beside `deleteNode`: `updateClaim` moves every attachment in ONE
 * `note_claims` UPDATE, and the edge half has to be the same shape or the two halves can
 * disagree about which topics moved. A loop would also need a read to learn the ids, and
 * that read is a second moment a concurrent attach can land in.
 *
 * Unconditional at its one call site, not gated on how many rows the `note_claims` UPDATE
 * moved: a predecessor holding an edge the membership table has no row for is exactly the
 * divergence this release exists to find, and closing it here is not a repair — the
 * successor's edge is written from `note_claims`' own result, so the parity control still
 * sees the disagreement it was there to report.
 */
export async function unlinkContainsInto(claimId: string, spaceId: string, ex: Ex): Promise<void> {
  await ex
    .update(vaultEdges)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(vaultEdges.spaceId, spaceId),
        eq(vaultEdges.toNodeId, claimId),
        eq(vaultEdges.relation, "contains"),
        isNull(vaultEdges.deletedAt),
      ),
    );
}

/**
 * THE inverse of `linkNodes` for the `references` edges a NOTE REVISION no longer mentions.
 *
 * A revision replaces a note's whole body, so a link the new body does not carry is a link
 * the note no longer makes — and an edge that outlived its token is the "edge without its
 * block" half of §4.8's invariant, arriving from the other side. It is a set operation for
 * the same reason `unlinkContainsInto` is one: the body is rewritten in a single statement,
 * so the edges have to move in a single statement or a reader can see the two disagree.
 *
 * `keepTargets` is the NEW body's target list, so re-linking a target that survived closes
 * nothing — `linkNodes` then finds the live edge and returns its id, which is what keeps the
 * stored token byte-identical across a revision that did not touch that link.
 */
export async function unlinkReferencesFrom(
  noteId: string,
  spaceId: string,
  keepTargets: string[],
  ex: Ex,
): Promise<void> {
  await ex
    .update(vaultEdges)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(vaultEdges.spaceId, spaceId),
        eq(vaultEdges.fromNodeId, noteId),
        eq(vaultEdges.relation, "references"),
        isNull(vaultEdges.deletedAt),
        ...(keepTargets.length ? [notInArray(vaultEdges.toNodeId, keepTargets)] : []),
      ),
    );
}

/**
 * §11.5's control for the dual-write period: the same membership, per space, on both
 * sides. It REPORTS, it does not repair — a repair would close the divergence this whole
 * period exists to detect, and the next release switches reads to the side that would then
 * have been quietly patched into agreement.
 *
 * Postgres does the comparison, both sides in one statement, because a JavaScript fold
 * over two separate reads is two moments and would report a concurrent attach as a
 * divergence.
 *
 * BOTH SIDES ARE SCOPED TO LIVE NODES, and that is not a convenience. `forgetClaim` leaves
 * the `note_claims` row exactly where it was ("forgetting a fact does not mean rewriting
 * where it came from") while `deleteNode` soft-deletes the claim's edges — so an unscoped
 * comparison would call every forgotten fact a divergence, which is a control that fires
 * on ordinary use and therefore tells nobody anything.
 *
 * The edge side is narrowed to `contains` edges that END at a claim: `note_claims` cannot
 * represent a topic containing a NOTE, so a note -> note `contains` edge is outside what
 * these two tables can be compared on, not evidence that they disagree.
 */
export async function containsParity(
  spaceId: string,
  ex: Ex = db,
): Promise<{ ok: boolean; onlyInNoteClaims: string[]; onlyInEdges: string[] }> {
  const res = await ex.execute(sql`
    WITH pairs AS (
      SELECT nc.note_id AS from_id, nc.claim_id AS to_id
        FROM note_claims nc
        JOIN vault_nodes fn ON fn.id = nc.note_id  AND fn.space_id = ${spaceId} AND fn.deleted_at IS NULL
        JOIN vault_nodes tn ON tn.id = nc.claim_id AND tn.space_id = ${spaceId} AND tn.deleted_at IS NULL
    ),
    live AS (
      SELECT e.from_node_id AS from_id, e.to_node_id AS to_id
        FROM vault_edges e
        JOIN vault_nodes tn ON tn.id = e.to_node_id AND tn.space_id = e.space_id AND tn.kind = 'claim'
       WHERE e.space_id = ${spaceId} AND e.relation = 'contains' AND e.deleted_at IS NULL
    )
    SELECT COALESCE(p.from_id, l.from_id) AS from_id,
           COALESCE(p.to_id, l.to_id)     AS to_id,
           (p.from_id IS NULL)            AS only_in_edges
      FROM pairs p
      FULL OUTER JOIN live l ON l.from_id = p.from_id AND l.to_id = p.to_id
     WHERE p.from_id IS NULL OR l.from_id IS NULL
     ORDER BY 1, 2`);
  const rows = res.rows as { from_id: string; to_id: string; only_in_edges: boolean }[];
  return {
    ok: rows.length === 0,
    onlyInNoteClaims: rows.filter((r) => !r.only_in_edges).map((r) => `${r.from_id}:${r.to_id}`),
    onlyInEdges: rows.filter((r) => r.only_in_edges).map((r) => `${r.from_id}:${r.to_id}`),
  };
}

export type ContainsParity = Awaited<ReturnType<typeof containsParity>>;

/** How many diverged pair ids one warning carries per side. The counts beside them are
 *  exact, so this bounds the LINE without bounding the diagnosis. */
const PARITY_LOG_SAMPLE = 20;

/**
 * THE PRODUCTION WITNESS for the control above, run periodically by the worker.
 *
 * `assertContainsParity` throws, and it is disarmed in production for good reason — a
 * divergence is a reporting matter, not grounds for taking a write down in front of a
 * person. So production needs a reader that looks at every live space on a slow interval
 * and says so in the log. That is this: it READS, it never repairs, and it never throws.
 * Repairing would close the very divergence the dual-write period exists to detect, and
 * the next release switches reads to the side that would then have been quietly patched
 * into agreement.
 *
 * A retired space is skipped: nothing writes to it any more, so a divergence there is
 * frozen history rather than a defect anybody can act on, and reporting it every six hours
 * would train the operator to ignore the line.
 *
 * ONE `log.warn` PER DIVERGED SPACE, carrying both directions, because which side has the
 * extra membership is the whole diagnosis — `note_claims` ahead of the edges means a
 * writer skipped `linkNodes`, the edges ahead means a delete closed an edge without
 * touching the projection.
 *
 * The two dependencies are INJECTED so the sweep can be unit-tested without a database:
 * the interesting behavior is which log lines come out, and a test that needed live
 * divergence to see one could not produce the diverged case at all.
 */
export async function sweepContainsParity(deps?: {
  liveSpaceIds?: () => Promise<string[]>;
  check?: (spaceId: string) => Promise<ContainsParity>;
}): Promise<void> {
  const liveSpaceIds =
    deps?.liveSpaceIds ??
    (async () =>
      (await db.select({ id: spacesTable.id }).from(spacesTable).where(isNull(spacesTable.retiredAt))).map((r) => r.id));
  const check = deps?.check ?? ((spaceId: string) => containsParity(spaceId));

  for (const spaceId of await liveSpaceIds()) {
    // PER SPACE, so one space that cannot be read does not end the sweep for the rest.
    // A control that reports on 4 of 40 spaces and says nothing about the other 36 is
    // worse than one that reports on none, because its silence reads as agreement.
    try {
      const parity = await check(spaceId);
      if (parity.ok) continue;
      // COUNTS IN FULL, IDS AS A SAMPLE. `containsParity` has no `LIMIT` - the assert path
      // needs the whole set to name it in the thrown message - so a wholesale divergence
      // (a bad backfill, a writer that stopped calling `linkNodes`) would put one line the
      // size of the divergence into the log. And nothing repairs it by design, so that line
      // repeats every six hours until a release lands. The counts are the size of the
      // problem and the sample is enough to start reading rows; the rest is in the tables.
      log.warn("vault contains parity diverged", {
        spaceId,
        onlyInNoteClaimsCount: parity.onlyInNoteClaims.length,
        onlyInEdgesCount: parity.onlyInEdges.length,
        onlyInNoteClaimsSample: parity.onlyInNoteClaims.slice(0, PARITY_LOG_SAMPLE),
        onlyInEdgesSample: parity.onlyInEdges.slice(0, PARITY_LOG_SAMPLE),
      });
    } catch (e) {
      log.error("vault contains parity check failed", { spaceId, err: String(e) });
    }
  }
}

/**
 * The control, ARMED, on every `contains` write outside production — and it throws, inside
 * the writer's own transaction, so a dual-write a later edit forgets to keep in step takes
 * the write down with it in dev instead of surviving to the read switch.
 *
 * It runs at the END of a move, never inside `linkNodes`: a supersede closes the
 * predecessor's edges and opens the successor's, and between those two statements the two
 * tables legitimately disagree. A check placed at the writer would fire on that window.
 *
 * In production it is not armed here at all — it is read through the admin reindex route,
 * which is the operator's existing repair surface for this space's projections.
 */
export async function assertContainsParity(spaceId: string, ex: Ex): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  const parity = await containsParity(spaceId, ex);
  if (parity.ok) return;
  throw new Error(
    `contains parity diverged in space ${spaceId}: ` +
      `only in note_claims [${parity.onlyInNoteClaims.join(", ")}], ` +
      `only in vault_edges [${parity.onlyInEdges.join(", ")}]`,
  );
}
