import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { DurablePluginReview } from "./review";

/**
 * The apply lifecycle journal (docs/plugin-install-review-spec.md §10).
 *
 * Deliberately NOT the existing `audit()`, which swallows its own failure. This one runs
 * inside the same transaction as the state transition it records and THROWS, so a journal
 * write that cannot land rolls that transition back. Merely logging would let the
 * transition commit while the journal asserts something different — the state and its
 * record disagreeing permanently, with a warning line to show for it.
 */

export type PluginApplyEvent = "accepted" | "succeeded" | "stale" | "blocked" | "failed";

const ACTION = {
  accepted: "plugin.apply_accepted",
  succeeded: "plugin.apply_succeeded",
  stale: "plugin.apply_stale",
  blocked: "plugin.apply_blocked",
  failed: "plugin.apply_failed",
} as const;

/** Thrown when the same event id already exists carrying a DIFFERENT outcome. */
export class AuditInvariantViolation extends Error {
  constructor(id: string, stored: unknown, incoming: unknown) {
    super(`Audit event ${id} already exists with a different outcome (stored ${JSON.stringify(stored)}, incoming ${JSON.stringify(incoming)})`);
    this.name = "AuditInvariantViolation";
  }
}

/** Deterministic, so two reconcilers — or one that runs twice — cannot duplicate a
 *  terminal event. `auditLog.id` is already a text primary key, so no schema change. */
export function applyEventId(operationId: string, event: PluginApplyEvent): string {
  return `plugin-apply:${operationId}:${event}`;
}

/**
 * A `policy.clear` entry for a rule an apply deleted, in the SAME transaction as the delete.
 *
 * The same action a hand edit records, so the permissions trail reads as one history rather
 * than splitting by cause — but carrying `operationId`, so the plugin operation that did it
 * is traceable. Without this a rule vanishes with only a `plugin.apply_succeeded` to explain
 * it, and someone auditing permissions would find a `deny` gone with nothing that says so.
 */
export async function insertPolicyClearAudit(
  tx: Tx,
  input: {
    actorId: string | null;
    operationId: string;
    row: { id: string; scope: string; capabilityType: string; capabilityKey: string; effect: string; userId: string | null; projectId: string | null };
  },
): Promise<void> {
  const detail = {
    operationId: input.operationId,
    scope: input.row.scope,
    capabilityType: input.row.capabilityType,
    capabilityKey: input.row.capabilityKey,
    effect: input.row.effect,
    userId: input.row.userId,
    projectId: input.row.projectId,
    via: "plugin-apply",
  };
  // Deterministic per (operation, policy), so a retried commit cannot double-log one delete.
  await tx.execute(sql`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_key, detail)
    VALUES (${`plugin-apply:${input.operationId}:policy:${input.row.id}`}, ${input.actorId}, 'policy.clear',
            ${input.row.capabilityType}, ${input.row.capabilityKey}, ${JSON.stringify(detail)}::jsonb)
    ON CONFLICT (id) DO NOTHING`);
}

/** Derived from `db.transaction` itself rather than spelled out: drizzle's transaction
 *  type carries four inferred generics, and naming them by hand is a guess that goes stale
 *  the moment the schema or driver type changes. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * Append one lifecycle event, idempotently.
 *
 * `accepted` carries the whole review; the terminal events carry only
 * `{ operationId, reviewHash, outcome, errorCode? }`, so the full review is stored once.
 *
 * The signature accepts only a `DurablePluginReview` — never a `ReviewResponse` — so the
 * literal command line cannot reach the journal by accident. That is a type boundary, not
 * a rule someone has to remember.
 *
 * `ON CONFLICT DO NOTHING` alone would silently swallow a DIFFERENT payload written under
 * the same id, leaving whichever arrived first with no signal that two writers disagreed.
 * So the insert reports whether it inserted, and on a conflict the stored outcome is
 * compared. Two reconcilers writing the same terminal event are the idempotent case; two
 * writing different ones are a bug that must stop the write it belongs to.
 */
export async function insertPluginAudit(
  tx: Tx,
  input: {
    operationId: string;
    event: PluginApplyEvent;
    actorId: string | null;
    /** Present only for `accepted`, which is where the full review is stored. */
    review?: DurablePluginReview;
    reviewHash: string;
    targetKey: string;
    errorCode?: string;
  },
): Promise<void> {
  const id = applyEventId(input.operationId, input.event);
  const outcome = input.event === "accepted" ? "pending" : input.event;
  const detail: Record<string, unknown> = {
    operationId: input.operationId,
    reviewHash: input.reviewHash,
    outcome,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.review ? { review: input.review } : {}),
  };

  const inserted = await tx.execute(sql`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_key, detail)
    VALUES (${id}, ${input.actorId}, ${ACTION[input.event]}, 'plugin', ${input.targetKey}, ${JSON.stringify(detail)}::jsonb)
    ON CONFLICT (id) DO NOTHING
    RETURNING id`);
  if ((inserted.rowCount ?? 0) > 0) return;

  // Compare the whole IDENTITY of the event, not just its outcome and hash. Two writers
  // disagreeing about the actor, the target or the error code is the same class of bug as
  // disagreeing about the outcome, and comparing only two fields would have called those
  // idempotent and kept whichever landed first.
  const existing = await tx.execute(sql`
    SELECT actor_id, action, target_key,
           detail #>> '{outcome}' AS outcome,
           detail #>> '{reviewHash}' AS review_hash,
           detail #>> '{errorCode}' AS error_code
      FROM audit_log WHERE id = ${id}`);
  const row = (existing.rows as {
    actor_id: string | null; action: string; target_key: string | null;
    outcome: string | null; review_hash: string | null; error_code: string | null;
  }[])[0];
  // A row we cannot read back after losing the conflict is not an idempotent success:
  // something else is going on, and this transaction must not commit on that basis.
  if (!row) throw new AuditInvariantViolation(id, null, { outcome, reviewHash: input.reviewHash });
  const incoming = {
    actor_id: input.actorId, action: ACTION[input.event], target_key: input.targetKey,
    outcome, review_hash: input.reviewHash, error_code: input.errorCode ?? null,
  };
  const stored = {
    actor_id: row.actor_id, action: row.action, target_key: row.target_key,
    outcome: row.outcome, review_hash: row.review_hash, error_code: row.error_code,
  };
  if (JSON.stringify(stored) !== JSON.stringify(incoming)) {
    throw new AuditInvariantViolation(id, stored, incoming);
  }
}
