import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { models } from "@/lib/db/schema";
import { realtime } from "@/lib/realtime";
import { claimNextTask, reconcileZombies, auxInFlight, INTERRUPTED_MESSAGE } from "@/lib/tasks/queue";
import { drainInFlight } from "@/lib/tasks/drain";
import { releaseHold } from "@/lib/billing/limits";
import { runAgentTask } from "@/lib/tasks/runner";
import { publishTaskEvent } from "@/lib/tasks/events";
import { syncModelCatalog } from "@/lib/models/catalog";
import { log } from "@/lib/log";

/**
 * In-process durable worker. Started once per server instance via
 * instrumentation. It claims queued tasks from Postgres and runs them in the
 * background — so work continues with the user's tab closed, and any number of
 * instances can run side-by-side (claims are atomic via SKIP LOCKED).
 *
 * Robust + simple: no external broker, all state in Postgres.
 */

// Per-instance concurrent-task ceiling. Configurable so a beefier host (or a
// multi-instance deployment that wants to tune throughput) can raise it without a
// code change; claims stay atomic across instances via SKIP LOCKED.
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_MAX_CONCURRENCY || "3", 10) || 3);
const POLL_MS = 5_000;
const RECONCILE_MS = 30_000;
const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
const CATALOG_STALE_MS = 12 * 60 * 60 * 1000;
/** On shutdown, how long to let already-running tasks finish before exiting.
 *  Most turns finish well inside this; the rare long one is reconciled as a
 *  retryable "interrupted" by the next instance. Keep the platform's
 *  stop_grace_period comfortably above this (see docker-compose.yml). */
const DRAIN_GRACE_MS = 25_000;

interface WorkerState {
  started: boolean;
  workerId: string;
  inFlight: number;
  ticking: boolean;
  /** Set on SIGTERM/SIGINT: stop claiming new tasks so the process can exit. */
  draining: boolean;
}

const g = globalThis as unknown as { __worker?: WorkerState };

function state(): WorkerState {
  if (!g.__worker) g.__worker = { started: false, workerId: `w_${nanoid(8)}`, inFlight: 0, ticking: false, draining: false };
  return g.__worker;
}

async function tick(): Promise<void> {
  const s = state();
  if (s.ticking || s.draining) return;
  s.ticking = true;
  try {
    while (s.inFlight < MAX_CONCURRENCY && !s.draining) {
      const task = await claimNextTask(s.workerId);
      if (!task) break;
      s.inFlight++;
      void runAgentTask(task, s.workerId)
        .catch((e) => log.error("task crashed", { workerId: s.workerId, taskId: task.id, chatId: task.chat_id, err: String(e) }))
        .finally(() => {
          s.inFlight--;
          void tick(); // a slot freed — try to claim more
        });
    }
  } catch (e) {
    log.error("tick error", { workerId: s.workerId, err: String(e) });
  } finally {
    s.ticking = false;
  }
}

async function reconcile(): Promise<void> {
  try {
    const dead = await reconcileZombies();
    for (const t of dead) {
      // A hard crash skipped the runner's finally, so its budget hold is still
      // pending — release it here so a dead turn never inflates the budget.
      await releaseHold(t.id);
      await publishTaskEvent(t.user_id, {
        type: "task:finish", taskId: t.id, chatId: t.chat_id, status: "failed",
        error: INTERRUPTED_MESSAGE,
      });
    }
    if (dead.length) log.info("reconciled zombie tasks", { count: dead.length, taskIds: dead.map((t) => t.id) });
  } catch (e) {
    log.error("reconcile error", { err: String(e) });
  }
}

async function refreshCatalogIfStale(): Promise<void> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int`, latest: sql<Date | null>`max(${models.updatedAt})` })
      .from(models);
    const empty = !row || row.n === 0;
    const stale = row?.latest ? Date.now() - new Date(row.latest).getTime() > CATALOG_STALE_MS : true;
    if (empty || stale) {
      log.info("refreshing model catalog", { reason: empty ? "empty" : "stale" });
      await syncModelCatalog();
    }
  } catch (e) {
    log.error("catalog refresh error", { err: String(e) });
  }
}

/**
 * Idempotent. Returns quickly: sets up the listener/intervals and kicks off
 * the first tick asynchronously so it never blocks server startup.
 */
export async function startWorker(): Promise<void> {
  const s = state();
  if (s.started) return;
  s.started = true;
  log.info("worker starting", { workerId: s.workerId });

  // Polling is the durable baseline and must exist BEFORE the optional LISTEN
  // fast path. A cold-start DB/LISTEN blip must not reject startWorker after the
  // started latch is set and leave this process permanently unable to claim work.
  const pollTimer = setInterval(() => void tick(), POLL_MS);
  void realtime.subscribe("task_enqueued", () => void tick()).catch((e) => {
    // Polling keeps the worker fully functional; Realtime reconnects established
    // subscriptions after later drops, while the next process start retries an
    // initial connection that never registered.
    log.warn("task LISTEN unavailable; polling fallback active", {
      workerId: s.workerId,
      err: String(e),
    });
  });

  // Reconcile zombies on boot and periodically.
  void reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_MS);

  // Keep the model catalog fresh (background, never blocks startup).
  void refreshCatalogIfStale();
  const catalogTimer = setInterval(() => void refreshCatalogIfStale(), CATALOG_REFRESH_MS);

  // Periodic health line: heap + the retainers a slow leak would show up in
  // (realtime listeners, the NOTIFY client's query queue, in-flight/aux work).
  // One line a minute so a memory incident can be diagnosed from the log
  // trail instead of requiring a live heap snapshot after the fact.
  const opsTimer = setInterval(() => {
    const mu = process.memoryUsage();
    log.info("ops", {
      heapUsedMb: Math.round(mu.heapUsed / 1048576),
      rssMb: Math.round(mu.rss / 1048576),
      externalMb: Math.round(mu.external / 1048576),
      inFlight: s.inFlight,
      aux: auxInFlight(),
      ...realtime.stats(),
    });
  }, 60_000);

  // Fire due automations (scheduled agent runs). Same pattern as reconcile:
  // cheap DB poll, safe across replicas via SKIP LOCKED inside the tick.
  const { schedulerTick } = await import("@/lib/automations/scheduler");
  // Fire anything already due right now (a due one-off shouldn't wait up to 30s
  // for the first interval after a deploy/restart), then poll on the interval.
  void schedulerTick().catch(() => {});
  const schedulerTimer = setInterval(() => void schedulerTick().catch(() => {}), 30_000);

  // Finish any project delete whose post-commit teardown failed (controller blip,
  // crash between commit and teardown): a tombstoned row is retried until its
  // sandbox/workspace/folders are gone and the row is physically removed.
  const { retryPendingProjectTeardowns } = await import("@/lib/projects/teardown");
  void retryPendingProjectTeardowns().catch(() => {});
  const teardownTimer = setInterval(() => void retryPendingProjectTeardowns().catch(() => {}), 60_000);

  // Graceful shutdown: a deploy/restart sends SIGTERM. WITHOUT this, every
  // in-flight task was killed mid-run and surfaced to the user as an interruption
  // (the single biggest source of "worker lost" failures during the beta, one
  // batch per redeploy). Now we stop claiming new work and let running tasks
  // finish within a grace window; anything still running when it elapses is
  // reconciled as a retryable "interrupted" by the next instance. Registered once
  // (startWorker is idempotent). Clearing the intervals lets the loop wind down.
  //
  // NEXT_MANUAL_SIG_HANDLE=1 (set in prod compose) suppresses Next's own SIGTERM
  // handler so this one owns shutdown — otherwise Next's server.close()→exit(143)
  // races and, for a background task with no open SSE, exits before we drain.
  const shutdown = async (signal: NodeJS.Signals) => {
    if (s.draining) return;
    s.draining = true;
    clearInterval(pollTimer);
    clearInterval(reconcileTimer);
    clearInterval(catalogTimer);
    clearInterval(opsTimer);
    clearInterval(schedulerTimer);
    clearInterval(teardownTimer);
    log.info("worker draining on signal — no new tasks; waiting for in-flight", { signal, workerId: s.workerId, inFlight: s.inFlight });
    // Also wait on fire-and-forget aux work (title/memory/compaction) so a deploy
    // doesn't kill an in-flight LLM call mid-write and lose the spend/checkpoint.
    const { drained, remaining } = await drainInFlight(() => state().inFlight + auxInFlight(), DRAIN_GRACE_MS);
    log.info("worker drain complete", { signal, workerId: s.workerId, drained, remaining });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Pick up anything already queued.
  void tick();
}
