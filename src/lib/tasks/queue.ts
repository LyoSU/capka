import { pool } from "@/lib/db";
import { realtime } from "@/lib/realtime";
import type { MessageMeta } from "@/lib/chat/contracts";

/**
 * Durable task queue on Postgres. Tasks are rows; a worker claims them
 * atomically with FOR UPDATE SKIP LOCKED and holds a time-bounded lease it
 * must renew via heartbeat. If a worker dies, its lease expires and the task
 * is reconciled — no zombies, no in-memory state, works with the user's tab
 * closed.
 */

export const LEASE_SECONDS = 60;

/**
 * Count of in-flight AUXILIARY work — the fire-and-forget LLM calls a finished
 * turn spawns (memory maintenance, chat-title generation, compaction). These
 * outlive the task that launched them (runAgentTask resolves the moment the main
 * reply is finalized), so the worker's drain — which only watches the task
 * in-flight count — used to exit on SIGTERM while they were still running,
 * killing them mid-flight (lost spend, dropped compaction checkpoints).
 *
 * `trackAux` wraps such a promise so the count rises for its lifetime and falls
 * when it settles; the worker's drain adds `auxInFlight()` to its wait condition
 * so a deploy/restart lets this work finish within the existing grace window.
 * Module-level (not per-request) so the single worker loop can observe it.
 */
const g = globalThis as unknown as { __auxInFlight?: number };
export function auxInFlight(): number {
  return g.__auxInFlight ?? 0;
}
export function trackAux<T>(p: Promise<T>): Promise<T> {
  g.__auxInFlight = (g.__auxInFlight ?? 0) + 1;
  return p.finally(() => {
    g.__auxInFlight = (g.__auxInFlight ?? 1) - 1;
  });
}

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
  // Neither arm returned a row: the incumbent was claimed (queued → running)
  // between our failed insert and the SELECT, so the partial unique index (QUEUED
  // rows only) no longer constrains the chat and the SELECT saw nothing. Loop the
  // insert-then-find a few times to settle the race deterministically:
  //   • the slot is free now → the re-insert creates a real queued follow-up
  //     carrying THIS message's payload (model switch / attachments), instead of
  //     dropping it onto the running turn (which re-reads only message TEXT);
  //   • another queued turn beat us to the freed slot → return THAT incumbent's
  //     real id so the caller's stop button targets the turn that will answer.
  // Either way we return a real, cancellable task id — never our own uninserted id.
  for (let attempt = 0; attempt < 5; attempt++) {
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
    const incumbent = await pool.query<{ id: string }>(
      `SELECT id FROM tasks WHERE chat_id = $1 AND status = 'queued' LIMIT 1`,
      [input.chatId],
    );
    if (incumbent.rows[0]) return { id: incumbent.rows[0].id, created: false };
    // Raced again (the incumbent was claimed before we read it): loop and retry.
  }
  // Sustained churn kept flipping the slot for every attempt (not seen in practice
  // — a chat has one human driving it). Surface it rather than hand back an id that
  // maps to no task; the caller persisted the message, so a manual resend recovers.
  throw new Error(`enqueueTask: could not settle a turn for chat ${input.chatId}`);
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
        INNER JOIN chats candidate_chat ON candidate_chat.id = t.chat_id
         WHERE t.status = 'queued'
           -- Serialize the workspace, not merely the chat. Every chat in one
           -- project mounts the same files, memory, and connectors; running two
           -- turns there concurrently creates nondeterministic writes. A chat
           -- outside a project is its own workspace. The transaction-scoped
           -- advisory lock closes the two-worker claim race: only one claimant
           -- may evaluate a workspace until its running row is committed.
           AND pg_try_advisory_xact_lock(
             hashtext(COALESCE(candidate_chat.project_id, candidate_chat.id))
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks r
             INNER JOIN chats running_chat ON running_chat.id = r.chat_id
              WHERE COALESCE(running_chat.project_id, running_chat.id) =
                    COALESCE(candidate_chat.project_id, candidate_chat.id)
                AND r.status = 'running'
                AND r.lease_expires_at > now()
         )
         ORDER BY t.created_at
         FOR UPDATE OF t SKIP LOCKED
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

/**
 * Renew a running task's lease. Returns false if the task is no longer ours —
 * which the runner's monitor treats as "lost lease" and aborts on.
 *
 * `lease_expires_at > now()` is part of the guard, not decoration: an EXPIRED
 * lease may never be renewed. `claimNextTask` excludes a workspace only while
 * some running task there still holds an unexpired lease, so the instant ours
 * lapses another worker is free to start a turn in the same workspace. A worker
 * that froze past expiry (a long GC pause, a DB outage) and then resurrected its
 * own lease would silently un-do that mutual exclusion after the fact and write
 * into files a second turn is already using. Refusing the renewal makes the
 * frozen worker stand down instead, which is the only safe direction.
 *
 * Losing the lease costs a full minute of missed renewals (LEASE_SECONDS) while
 * the monitor retries every 5s, so this is not tripped by one hiccup.
 */
export async function heartbeat(id: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tasks
        SET heartbeat_at = now(),
            lease_expires_at = now() + ($2 || ' seconds')::interval
      WHERE id = $1 AND status = 'running' AND worker_id = $3
        AND lease_expires_at > now()`,
    [id, String(LEASE_SECONDS), workerId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Mark a task finished, but only if nothing has finished it already.
 *
 * Compare-and-set against a terminal status, because the write races
 * `reconcileZombies`: a worker that stalled long enough to lose its lease gets
 * reaped to `failed`, and if it then wakes up an unconditional UPDATE would revive
 * the row as `completed` — the user watching the turn sees "interrupted" flip to an
 * answer, or the reverse. The 15-second reap margin makes that rare; this makes it
 * impossible. First terminal status wins.
 *
 * Returns false when the row was already terminal, i.e. this run no longer owns the
 * turn's outcome.
 */
export async function finalizeTask(
  id: string,
  status: Extract<TaskStatus, "completed" | "failed" | "cancelled">,
  error?: string | null,
  /** The worker claiming the outcome. Adds an ownership check to the CAS; omit only
   *  where there is no run to own the row (clearing a still-queued task). */
  workerId?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tasks SET status = $2, error = $3, updated_at = now()
      WHERE id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')
        ${workerId ? "AND worker_id = $4" : ""}`,
    workerId ? [id, status, error ?? null, workerId] : [id, status, error ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Settle a turn's outcome: the task's terminal status and the assistant message's
 * final content/metadata, in ONE transaction, gated by the same compare-and-set as
 * {@link finalizeTask}.
 *
 * Guarding only the task row is not enough. What the user actually sees is the
 * message row and the realtime event, so a reaped worker that wakes up could leave
 * the task `failed` while rewriting the message to `completed` and pushing the
 * answer out — the "interrupted flips to an answer" the reaper exists to prevent,
 * just moved one table over. Binding both writes to the CAS makes the outcome a
 * single decision: whoever wins it owns the message, the event, the channel push and
 * the follow-up work; whoever loses must not touch any of them.
 *
 * Returns false when the outcome was already settled — by then `reconcileZombies`
 * has told the user the turn was interrupted, and that verdict stands.
 *
 * Money is deliberately NOT part of this: tokens were really spent whoever owns the
 * outcome, so the caller settles the usage ledger before calling and regardless of
 * the answer here.
 *
 * Throwing is NOT the same answer as `false`. False means someone else owns the
 * outcome and the caller must stand down; a throw means the question is unanswerable
 * (the database is unreachable) — and then nobody else recorded an outcome either,
 * so a caller whose job is to report a failure should still report it.
 */
export async function commitTurnOutcome(input: {
  taskId: string;
  workerId: string;
  status: Extract<TaskStatus, "completed" | "failed" | "cancelled">;
  error?: string | null;
  message: {
    id: string;
    content: string;
    metadata: MessageMeta;
    /**
     * Set when the assistant row does not exist yet — a failure before the reply was
     * ever inserted (e.g. the provider was gone at setup). The row is inserted and
     * the chat's leaf moved to it inside this same transaction, so the failure is a
     * visible message rather than a silent dead end.
     *
     * This is why the insert cannot be left outside: `reconcileZombies` repairs an
     * existing message stranded at `running`, but it cannot conjure one that was
     * never written — so a crash between the CAS and an out-of-transaction insert
     * would leave a terminal task with nothing in the chat at all.
     */
    insert?: { chatId: string; parentId: string | null; platform: string };
  };
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE tasks SET status = $2, error = $3, updated_at = now()
        WHERE id = $1 AND worker_id = $4 AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [input.taskId, input.status, input.error ?? null, input.workerId],
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    const { id, content, metadata, insert } = input.message;
    const meta = JSON.stringify(metadata);
    if (insert) {
      await client.query(
        `INSERT INTO messages (id, chat_id, parent_id, role, content, platform, metadata)
         VALUES ($1, $2, $3, 'assistant', $4, $5, $6::jsonb)`,
        [id, insert.chatId, insert.parentId, content, insert.platform, meta],
      );
      await client.query(`UPDATE chats SET active_leaf_id = $1 WHERE id = $2`, [id, insert.chatId]);
    } else {
      await client.query(`UPDATE messages SET content = $2, metadata = $3::jsonb WHERE id = $1`, [id, content, meta]);
    }
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
 * Fail any running task whose lease has expired (its worker died), reconcile its
 * abandoned assistant message, AND settle its outstanding budget hold — all in
 * one statement. tasks.status, messages.metadata.status, and the pending usage
 * row represent one logical state: leaving the message at "running" revives a
 * stuck spinner on reload, and leaving the hold pending inflates the user's
 * budget until the 30-day window rolls. So all three move together atomically.
 *
 * The hold sweep is deliberately broader than the reaped set: it also clears any
 * pending hold whose owning task is ALREADY terminal (completed/failed/cancelled
 * — e.g. a crash between finalizeTask and reconcileUsage left a completed task
 * holding a pending estimate forever, or releaseHold's DB delete failed and was
 * swallowed). This makes a leaked hold recoverable on the next sweep instead of
 * permanent-until-30-days. Returns the reaped task rows so the caller notifies
 * connected clients.
 */
export async function reconcileZombies(): Promise<Array<Pick<TaskRow, "id" | "user_id" | "chat_id">>> {
  const { rows } = await pool.query<Pick<TaskRow, "id" | "user_id" | "chat_id">>(
    `WITH dead AS (
        UPDATE tasks
           SET status = 'failed',
               error = 'worker lost (lease expired)',
               updated_at = now()
         -- Margin past expiry so a SINGLE missed heartbeat (a transient DB hiccup —
         -- the monitor swallows one and retries next tick) doesn't reap a task that's
         -- still streaming. Without it the reconciler could fail+publish a turn the
         -- runner then finalizes again → the user sees "interrupted" flip to the real
         -- answer (double finalize).
         WHERE status = 'running' AND lease_expires_at < now() - interval '15 seconds'
         RETURNING id, user_id, chat_id
     ), reconciled_messages AS (
        UPDATE messages m
           SET metadata = m.metadata || jsonb_build_object('status', 'failed', 'error', $1::text, 'errorCategory', 'interrupted')
          FROM dead
         WHERE m.metadata->>'taskId' = dead.id
           AND m.metadata->>'status' = 'running'
     ), reconciled_terminal AS (
        -- Messages stranded at 'running' whose owning task ALREADY reached a
        -- terminal, non-success status: the failure path's finalizeTask succeeded
        -- but the message UPDATE was lost (swallowed .catch), so the row keeps a
        -- live spinner across every reload. The dead CTE above only covers
        -- lease-expired zombies (status still 'running'), never an already-failed
        -- task, so this is the sibling repair -- mirroring swept_holds' broader
        -- terminal sweep. 'completed' is excluded so a genuinely finished answer is
        -- never rewritten to "interrupted".
        UPDATE messages m
           SET metadata = m.metadata || jsonb_build_object('status', 'failed', 'error', $1::text, 'errorCategory', 'interrupted')
          FROM tasks t
         WHERE m.metadata->>'taskId' = t.id
           AND m.metadata->>'status' = 'running'
           AND t.status IN ('failed', 'cancelled')
     ), swept_holds AS (
        -- Release every pending hold whose task is no longer live: the ones we
        -- just reaped (the dead CTE flips them this same statement, so a sibling
        -- read of tasks would not see it yet -- union them in explicitly), plus
        -- any whose owning task already reached a terminal status (H5 crash-window
        -- holds, swallowed releaseHold failures). A terminal task real spend, if
        -- any, was reconciled to its own row, so whatever is still pending here is
        -- a stale estimate -- delete it.
        DELETE FROM usage u
         USING tasks t
         WHERE u.pending = true
           AND u.task_id = t.id
           AND (t.status IN ('completed', 'failed', 'cancelled')
                OR u.task_id IN (SELECT id FROM dead))
     )
     SELECT id, user_id, chat_id FROM dead`,
    [INTERRUPTED_MESSAGE],
  );
  return rows;
}
