import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { models } from "@/lib/db/schema";
import { realtime } from "@/lib/realtime";
import { claimNextTask, reconcileZombies } from "@/lib/tasks/queue";
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

const MAX_CONCURRENCY = 3;
const POLL_MS = 5_000;
const RECONCILE_MS = 30_000;
const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
const CATALOG_STALE_MS = 12 * 60 * 60 * 1000;

interface WorkerState {
  started: boolean;
  workerId: string;
  inFlight: number;
  ticking: boolean;
}

const g = globalThis as unknown as { __worker?: WorkerState };

function state(): WorkerState {
  if (!g.__worker) g.__worker = { started: false, workerId: `w_${nanoid(8)}`, inFlight: 0, ticking: false };
  return g.__worker;
}

async function tick(): Promise<void> {
  const s = state();
  if (s.ticking) return;
  s.ticking = true;
  try {
    while (s.inFlight < MAX_CONCURRENCY) {
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
      await publishTaskEvent(t.user_id, {
        type: "task:finish", taskId: t.id, chatId: t.chat_id, status: "failed",
        error: "The task was interrupted before it finished. Please try again.",
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

  // Wake on enqueue (cross-process via NOTIFY), with a polling fallback.
  await realtime.subscribe("task_enqueued", () => void tick());
  setInterval(() => void tick(), POLL_MS);

  // Reconcile zombies on boot and periodically.
  void reconcile();
  setInterval(() => void reconcile(), RECONCILE_MS);

  // Keep the model catalog fresh (background, never blocks startup).
  void refreshCatalogIfStale();
  setInterval(() => void refreshCatalogIfStale(), CATALOG_REFRESH_MS);

  // Pick up anything already queued.
  void tick();
}
