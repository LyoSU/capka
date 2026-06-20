import { pool } from "@/lib/db";
import { realtime } from "@/lib/realtime";

/**
 * Durable task queue on Postgres. Tasks are rows; a worker claims them
 * atomically with FOR UPDATE SKIP LOCKED and holds a time-bounded lease it
 * must renew via heartbeat. If a worker dies, its lease expires and the task
 * is reconciled — no zombies, no in-memory state, works with the user's tab
 * closed.
 */

export const LEASE_SECONDS = 60;

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TaskRow {
  id: string;
  chat_id: string;
  user_id: string;
  status: TaskStatus;
  error: string | null;
  payload: unknown;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  worker_id: string | null;
  cancel_requested: boolean;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

/** Insert a queued task and wake any listening worker. */
export async function enqueueTask(input: {
  id: string;
  chatId: string;
  userId: string;
  payload: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (id, chat_id, user_id, status, payload)
     VALUES ($1, $2, $3, 'queued', $4)`,
    [input.id, input.chatId, input.userId, JSON.stringify(input.payload)],
  );
  await realtime.publish("task_enqueued", { id: input.id });
}

/** Atomically claim the oldest queued task, taking a lease. Returns null if none. */
export async function claimNextTask(workerId: string): Promise<TaskRow | null> {
  const { rows } = await pool.query<TaskRow>(
    `UPDATE tasks
        SET status = 'running',
            worker_id = $1,
            lease_expires_at = now() + ($2 || ' seconds')::interval,
            heartbeat_at = now(),
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = (
        SELECT id FROM tasks
         WHERE status = 'queued'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [workerId, String(LEASE_SECONDS)],
  );
  return rows[0] ?? null;
}

/** Renew a running task's lease. Returns false if the task is no longer ours. */
export async function heartbeat(id: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tasks
        SET heartbeat_at = now(),
            lease_expires_at = now() + ($2 || ' seconds')::interval
      WHERE id = $1 AND status = 'running' AND worker_id = $3`,
    [id, String(LEASE_SECONDS), workerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Mark a task finished. */
export async function finalizeTask(
  id: string,
  status: Extract<TaskStatus, "completed" | "failed" | "cancelled">,
  error?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE tasks SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error ?? null],
  );
}

/** Request cooperative cancellation (cross-process: a flag the runner polls). */
export async function requestCancel(id: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET cancel_requested = true, updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function isCancelRequested(id: string): Promise<boolean> {
  const { rows } = await pool.query<{ cancel_requested: boolean }>(
    `SELECT cancel_requested FROM tasks WHERE id = $1`,
    [id],
  );
  return rows[0]?.cancel_requested ?? false;
}

/**
 * User-facing text for a task whose worker died mid-flight. Shared by the
 * persisted message metadata and the live SSE so a reload and a live tab show
 * the exact same thing.
 */
export const INTERRUPTED_MESSAGE =
  "The task was interrupted before it finished. Please try again.";

/**
 * Fail any running task whose lease has expired (its worker died), AND reconcile
 * its abandoned assistant message in the same statement. The two live in
 * separate tables (`tasks.status` vs `messages.metadata.status`) but represent
 * one logical state — leaving the message at "running" makes the client revive a
 * stuck spinner on every history reload, so both must move together atomically.
 * Returns the reconciled task rows so the caller can notify connected clients.
 */
export async function reconcileZombies(): Promise<Array<Pick<TaskRow, "id" | "user_id" | "chat_id">>> {
  const { rows } = await pool.query<Pick<TaskRow, "id" | "user_id" | "chat_id">>(
    `WITH dead AS (
        UPDATE tasks
           SET status = 'failed',
               error = 'worker lost (lease expired)',
               updated_at = now()
         WHERE status = 'running' AND lease_expires_at < now()
         RETURNING id, user_id, chat_id
     ), reconciled_messages AS (
        UPDATE messages m
           SET metadata = m.metadata || jsonb_build_object('status', 'failed', 'error', $1::text, 'errorCategory', 'interrupted')
          FROM dead
         WHERE m.metadata->>'taskId' = dead.id
           AND m.metadata->>'status' = 'running'
     )
     SELECT id, user_id, chat_id FROM dead`,
    [INTERRUPTED_MESSAGE],
  );
  return rows;
}
