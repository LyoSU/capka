import { sql } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { realtime } from "@/lib/realtime";
import type { MessageMeta } from "@/lib/chat/contracts";
import { INTERRUPTED_ERROR, INTERRUPTED_PARTIAL_ERROR } from "@/lib/errors/friendly";

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
 * A drizzle transaction, or the pool-backed `db` when there isn't one. Mirrors
 * the marketplace's `OperationTx` — the way this codebase lets a caller pull a
 * module's own write into a wider transaction without the module growing a
 * second implementation of it.
 */
export type QueueTx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/** Wake a worker for a turn enqueued inside a transaction. Call it AFTER the
 *  commit: before it, the row the woken worker goes looking for isn't visible to
 *  any other connection, and the wake is wasted. */
export async function notifyTaskEnqueued(id: string): Promise<void> {
  await realtime.publish("task_enqueued", { id });
}

/** Wake now, unless we're inside a caller's transaction (see notifyTaskEnqueued). */
async function wake(id: string, tx?: QueueTx): Promise<void> {
  if (!tx) await realtime.publish("task_enqueued", { id });
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
 *
 * Pass `tx` to enqueue inside a caller's transaction — the resume paths do, so
 * that recording a decision and queuing the turn that acts on it either both
 * happen or neither does (see manage/ask `authed.ts`). In that mode the wake-up
 * NOTIFY is NOT sent: it rides a separate connection, so a worker woken before
 * the commit would look for a row that isn't visible yet and fall back to its
 * 5s poll. The caller must call `notifyTaskEnqueued` AFTER it commits.
 */
export async function enqueueTask(input: {
  id: string;
  chatId: string;
  userId: string;
  payload: unknown;
}, tx?: QueueTx): Promise<{ id: string; created: boolean }> {
  const exec = tx ?? db;
  // One round-trip: try the insert; if the partial unique index rejects it,
  // fall through to the chat's existing pending turn. Exactly one row comes back
  // — the inserted row (created=true) OR the incumbent (created=false) — because
  // the second arm is gated on the insert having produced nothing.
  const first = await exec.execute(sql`
     WITH ins AS (
       INSERT INTO tasks (id, chat_id, user_id, status, payload)
       VALUES (${input.id}, ${input.chatId}, ${input.userId}, 'queued', ${JSON.stringify(input.payload)}::jsonb)
       ON CONFLICT (chat_id) WHERE status = 'queued' DO NOTHING
       RETURNING id
     )
     SELECT id, true AS created FROM ins
     UNION ALL
     SELECT id, false AS created FROM tasks
      WHERE chat_id = ${input.chatId} AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM ins)
      LIMIT 1`);
  const row = (first.rows as { id: string; created: boolean }[])[0];
  if (row) {
    if (row.created) await wake(row.id, tx);
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
    const retry = await exec.execute(sql`
      INSERT INTO tasks (id, chat_id, user_id, status, payload)
       VALUES (${input.id}, ${input.chatId}, ${input.userId}, 'queued', ${JSON.stringify(input.payload)}::jsonb)
       ON CONFLICT (chat_id) WHERE status = 'queued' DO NOTHING
       RETURNING id`);
    const inserted = (retry.rows as { id: string }[])[0];
    if (inserted) {
      await wake(inserted.id, tx);
      return { id: inserted.id, created: true };
    }
    const incumbent = await exec.execute(sql`
      SELECT id FROM tasks WHERE chat_id = ${input.chatId} AND status = 'queued' LIMIT 1`);
    const existing = (incumbent.rows as { id: string }[])[0];
    if (existing) return { id: existing.id, created: false };
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
      const { rowCount } = await client.query(
        `UPDATE messages SET content = $2, metadata = $3::jsonb WHERE id = $1`,
        [id, content, meta],
      );
      // The reply row is gone — deleted (or its subtree pruned) between this task
      // being enqueued and reaching here. Without this check the UPDATE matched
      // nothing, the transaction committed, and the task reported COMPLETED with no
      // reply anywhere in the chat: a turn that both succeeded and left no trace.
      // Roll back and answer like any other lost race, so the caller stands down
      // instead of claiming an outcome it did not write.
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        // `false` otherwise means "another actor owns this outcome", and the callers
        // log exactly that. This case is different and must not hide inside it: the
        // task WAS ours and the reply is simply gone. Named here so a genuinely lost
        // reply is greppable rather than reading as an ordinary lost race.
        console.warn(`[queue] reply row ${id} is gone; standing down instead of reporting an outcome for task ${input.taskId}`);
        return false;
      }
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

/** A task the reaper failed, plus whether its row still holds work worth keeping —
 *  the caller needs that to tell a live tab the same thing the reloaded row says. */
export type ReconciledZombie = Pick<TaskRow, "id" | "user_id" | "chat_id"> & { partial: boolean };

/**
 * User-facing text for a task whose worker died mid-flight. Shared by the
 * persisted message metadata and the live SSE so a reload and a live tab show
 * the exact same thing.
 *
 * Taken FROM the friendly errors rather than written again here. These used to be
 * a separate sentence ("The task was interrupted before it finished"), which meant
 * one event was described two ways depending on whether the runner or the
 * reconciler happened to win the finalize race — and only one of them could ever
 * be the one the category renders to.
 */
export const INTERRUPTED_MESSAGE = INTERRUPTED_ERROR.userMessage;
/** Its partial twin: the crash landed on a turn that had already produced work. */
export const INTERRUPTED_PARTIAL_MESSAGE = INTERRUPTED_PARTIAL_ERROR.userMessage;

/**
 * The SQL twin of `producedWork` (errors/friendly.ts): did this row's saved parts
 * leave the user anything to keep? Finished text, a tool result, or a tool that ran
 * and threw — a failed tool still had its hands on the workspace. Reasoning and an
 * unanswered tool call are not work.
 *
 * It has to be written twice because one side is TypeScript and the other is a
 * statement Postgres runs without us; the pairing is pinned by
 * __tests__/reconcile-partial.test.ts, and any change here belongs in both.
 */
const PRODUCED_WORK_SQL = `EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.metadata->'parts') = 'array'
                 THEN m.metadata->'parts' ELSE '[]'::jsonb END) AS p
           WHERE p->>'type' = 'tool-result'
              -- Excluded: a tool-error the SDK synthesized for a call it rejected
              -- BEFORE running it. Mirrors producedWork in errors/friendly.ts; the
              -- two are one definition in two languages and must move together.
              OR (p->>'type' = 'tool-error' AND p->>'invalid' IS DISTINCT FROM 'true')
              OR (p->>'type' = 'text' AND btrim(COALESCE(p->>'text', '')) <> ''))`;

/** What to merge into a stranded message, split on the evidence above. $1 is the
 *  total-loss sentence, $2 the partial one. */
const INTERRUPTED_METADATA_SQL = `CASE WHEN ${PRODUCED_WORK_SQL}
            THEN jsonb_build_object('status', 'failed', 'error', $2::text, 'errorCategory', 'interrupted_partial')
            ELSE jsonb_build_object('status', 'failed', 'error', $1::text, 'errorCategory', 'interrupted')
          END`;

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
export async function reconcileZombies(): Promise<ReconciledZombie[]> {
  const { rows } = await pool.query<ReconciledZombie>(
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
           SET metadata = m.metadata || ${INTERRUPTED_METADATA_SQL}
          FROM dead
         WHERE m.metadata->>'taskId' = dead.id
           AND m.metadata->>'status' = 'running'
        -- The verdict just written, handed back so the live tab is told the same
        -- thing the reloaded row will say.
        RETURNING dead.id AS task_id, m.metadata->>'errorCategory' = 'interrupted_partial' AS partial
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
           SET metadata = m.metadata || ${INTERRUPTED_METADATA_SQL}
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
     SELECT d.id, d.user_id, d.chat_id, COALESCE(rm.partial, false) AS partial
       FROM dead d LEFT JOIN reconciled_messages rm ON rm.task_id = d.id`,
    [INTERRUPTED_MESSAGE, INTERRUPTED_PARTIAL_MESSAGE],
  );
  return rows;
}
