import type { QueryResultRow } from "pg";
import { pool } from "@/lib/db";

const RETENTION_LOCK_ID = 1_129_334_859; // stable signed int: "CAPK"
const MAX_BATCHES_PER_RUN = 10;

export interface RetentionConfig {
  taskDays: number;
  usageDays: number;
  auditDays: number;
  batchSize: number;
}

export interface RetentionResult {
  tasks: number;
  usage: number;
  audit: number;
  skipped: boolean;
}

interface RetentionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = nonNegativeInt(raw, fallback);
  return value > 0 ? value : fallback;
}

/** Retention is intentionally different per data class: task payloads are bulky
 * operational history, while usage is a money ledger and audit rows are security
 * evidence. Set a *_DAYS value to 0 to keep that table indefinitely. */
export function readRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): RetentionConfig {
  return {
    taskDays: nonNegativeInt(env.TASK_RETENTION_DAYS, 30),
    usageDays: nonNegativeInt(env.USAGE_RETENTION_DAYS, 365),
    auditDays: nonNegativeInt(env.AUDIT_RETENTION_DAYS, 365),
    batchSize: positiveInt(env.DB_RETENTION_BATCH_SIZE, 1_000),
  };
}

async function deleteInBatches(
  client: RetentionClient,
  sql: string,
  days: number,
  batchSize: number,
): Promise<number> {
  if (days === 0) return 0;
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const result = await client.query(sql, [days, batchSize]);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

/** Delete only bounded batches. Live queue rows, suspended turns awaiting human
 * input, and pending budget holds are never retention candidates, regardless of
 * age. `SKIP LOCKED` avoids waiting behind a task finalizer or reconciliation. */
export async function cleanupRetention(
  client: RetentionClient,
  config: RetentionConfig,
): Promise<Omit<RetentionResult, "skipped">> {
  const tasks = await deleteInBatches(
    client,
    `DELETE FROM tasks WHERE id IN (
       SELECT candidate.id FROM tasks AS candidate
       WHERE candidate.status IN ('completed', 'failed', 'cancelled')
         AND candidate.updated_at < now() - ($1 * interval '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM messages
           WHERE messages.metadata->>'taskId' = candidate.id
             AND messages.metadata->>'status' IN ('awaiting_answer', 'awaiting_approval')
         )
       ORDER BY candidate.updated_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )`,
    config.taskDays,
    config.batchSize,
  );
  const usage = await deleteInBatches(
    client,
    `DELETE FROM usage WHERE id IN (
       SELECT candidate.id FROM usage AS candidate
       WHERE candidate.pending = false
         AND candidate.created_at < now() - ($1 * interval '1 day')
       ORDER BY candidate.created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )`,
    config.usageDays,
    config.batchSize,
  );
  const audit = await deleteInBatches(
    client,
    `DELETE FROM audit_log WHERE id IN (
       SELECT candidate.id FROM audit_log AS candidate
       WHERE candidate.created_at < now() - ($1 * interval '1 day')
       ORDER BY candidate.created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )`,
    config.auditDays,
    config.batchSize,
  );
  return { tasks, usage, audit };
}

/** One replica performs the daily sweep. A transaction-scoped advisory lock is
 * released by Postgres on COMMIT/ROLLBACK, so a pooled connection can never retain
 * the cleanup lock after an error. */
export async function runRetentionCleanup(
  config: RetentionConfig = readRetentionConfig(),
): Promise<RetentionResult> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [RETENTION_LOCK_ID],
    );
    if (!lock.rows[0]?.locked) {
      await client.query("COMMIT");
      inTransaction = false;
      return { tasks: 0, usage: 0, audit: 0, skipped: true };
    }
    const result = await cleanupRetention(client as RetentionClient, config);
    await client.query("COMMIT");
    inTransaction = false;
    return { ...result, skipped: false };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
