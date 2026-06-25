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

/**
 * Enqueue a turn for a chat, coalescing instead of duplicating.
 *
 * A chat holds at most one pending (queued) turn — enforced in the DB by the
 * `uq_tasks_one_queued_per_chat` partial unique index, not by hope. So if the
 * chat already has a pending turn (because another tab/device/Telegram message
 * or a stale-after-failure client just enqueued one), this insert conflicts and
 * we DON'T create a second turn: the caller already persisted the user message,
 * and the existing pending turn rebuilds its context from the live tree when it
 * runs (see runAgentTask), so the new message folds into that one reply.
 *
 * Returns the id of the turn that will actually answer — the freshly inserted
 * one, or the existing pending one it folded into — so the caller hands the
 * client a taskId that maps to a real, cancellable turn (never a phantom).
 * `created` says which happened; we only wake a worker when a turn was truly
 * created (a folded message rides a turn a worker will already pick up).
 */
export async function enqueueTask(input: {
  id: string;
  chatId: string;
  userId: string;
  payload: unknown;
}): Promise<{ id: string; created: boolean }> {
  // One round-trip: try the insert; if the partial unique index rejects it,
  // fall through to the chat's existing pending turn. Exactly one row comes back
  // — the inserted row (created=true) OR the incumbent (created=false) — because
  // the second arm is gated on the insert having produced nothing.
  const { rows } = await pool.query<{ id: string; created: boolean }>(
    `WITH ins AS (
       INSERT INTO tasks (id, chat_id, user_id, status, payload)
       VALUES ($1, $2, $3, 'queued', $4)
       ON CONFLICT (chat_id) WHERE status = 'queued' DO NOTHING
       RETURNING id
     )
     SELECT id, true AS created FROM ins
     UNION ALL
     SELECT id, false AS created FROM tasks
      WHERE chat_id = $2 AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM ins)
      LIMIT 1`,
    [input.id, input.chatId, input.userId, JSON.stringify(input.payload)],
  );
  const row = rows[0];
  if (row) {
    if (row.created) await realtime.publish("task_enqueued", { id: row.id });
    return row;
  }
  // Rare race: the incumbent was claimed (queued → running) between our failed
  // insert and the SELECT, so neither arm returned a row. The partial unique
  // index only covers QUEUED rows, so the slot is free again now — retry the
  // insert once. This creates a real queued follow-up carrying THIS message's
  // payload (its model switch / attachments) instead of silently dropping it
  // onto the running turn (which only re-reads message TEXT from the live tree,
  // not the new task payload).
  const retry = await pool.query<{ id: string }>(
    `INSERT INTO tasks (id, chat_id, user_id, status, payload)
     VALUES ($1, $2, $3, 'queued', $4)
     ON CONFLICT (chat_id) WHERE status = 'queued' DO NOTHING
     RETURNING id`,
    [input.id, input.chatId, input.userId, JSON.stringify(input.payload)],
  );
  if (retry.rows[0]) {
    await realtime.publish("task_enqueued", { id: retry.rows[0].id });
    return { id: retry.rows[0].id, created: true };
  }
  // Still nothing — another queued turn beat us to the freed slot; the caller's
  // message is already persisted, so it folds into that turn's live-tree rebuild.
  return { id: input.id, created: false };
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
        SELECT t.id FROM tasks t
         WHERE t.status = 'queued'
           -- Serialize per chat: don't start a turn while that chat's previous
           -- turn is still live, so replies stay in order and a follow-up sees
           -- the prior answer (like Claude Code queueing messages). A dead
           -- worker's expired lease stops blocking the chat.
           AND NOT EXISTS (
             SELECT 1 FROM tasks r
              WHERE r.chat_id = t.chat_id
                AND r.status = 'running'
                AND r.lease_expires_at > now()
           )
         ORDER BY t.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [workerId, String(LEASE_SECONDS)],
  );
  return rows[0] ?? null;
}

/**
 * Remove the other queued tasks for a chat, returning them. Used to batch a
 * burst of follow-up messages: the turn that's about to run answers from the
 * chat's latest message and absorbs the tasks those follow-ups created, so the
 * whole burst becomes one reply instead of a reply each.
 */
export async function absorbQueuedTasks(chatId: string, exceptId: string): Promise<TaskRow[]> {
  const { rows } = await pool.query<TaskRow>(
    `DELETE FROM tasks WHERE chat_id = $1 AND status = 'queued' AND id <> $2 RETURNING *`,
    [chatId, exceptId],
  );
  return rows;
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
