import { eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { nextOccurrenceAfter, type AutomationTrigger } from "./schedule";
import { fireAutomation, MAX_CONSECUTIVE_FAILURES, type AutomationRow } from "./runs";
import { log } from "@/lib/log";

/**
 * One pass: claim every due automation and fire it. Claiming happens in a
 * transaction with FOR UPDATE SKIP LOCKED (multiple platform replicas each run
 * this tick; a row is claimed by exactly one), and next_run_at moves FORWARD
 * inside that same transaction — so a crash between claim and fire loses at
 * most one occurrence, never double-fires. Missed occurrences are NOT backfilled
 * (self-hosted boxes sleep): next_run_at is always computed from `now`.
 */
export async function schedulerTick(now: Date = new Date()): Promise<void> {
  const client = await pool.connect();
  // Each claimed row is tagged with the exact updated_at this tick stamped on it,
  // so the error-recovery below can tell "nobody touched it" from "the user paused
  // or deleted it mid-fire" via a CAS on updated_at (a JS-precision timestamp we
  // control, not now(), so it round-trips exactly for the compare).
  const claimed: Array<{ row: AutomationRow; tickTs: Date }> = [];
  const tickTs = new Date();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM automations
        WHERE enabled = true AND next_run_at <= $1
        ORDER BY next_run_at
        LIMIT 20
        FOR UPDATE SKIP LOCKED`,
      [now],
    );
    for (const raw of rows) {
      const trigger = raw.trigger as AutomationTrigger;
      let next: Date | null = null;
      try {
        next = nextOccurrenceAfter(trigger, now);
      } catch (e) {
        // A trigger that stopped parsing (shouldn't happen — validated at add)
        // must not wedge the tick forever: disable it.
        log.error("automation trigger unparseable — disabling", { automationId: raw.id, err: String(e) });
      }
      await client.query(
        `UPDATE automations SET next_run_at = $2, enabled = $3, updated_at = $4 WHERE id = $1`,
        [raw.id, next, next !== null, tickTs], // once-triggers naturally finish here
      );
      claimed.push({
        row: {
          ...raw,
          // pg returns snake_case — map the fields fireAutomation reads:
          userId: raw.user_id, projectId: raw.project_id, lastTaskId: raw.last_task_id,
          lastRunAt: raw.last_run_at, nextRunAt: raw.next_run_at,
          consecutiveFailures: raw.consecutive_failures, createdAt: raw.created_at, updatedAt: tickTs,
        } as AutomationRow,
        tickTs,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log.error("scheduler tick failed", { err: String(e) });
    return;
  } finally {
    client.release();
  }
  // Fire AFTER commit so a slow/failed materialization can't hold row locks. The
  // tick already advanced next_run_at past this occurrence; a fire that THROWS
  // (DB blip, enqueue error — not the intentional overlap skip, which returns
  // {fired:false}) would otherwise drop the occurrence silently, and for a
  // one-off leave it disabled with no run at all. So on a throw restore the
  // original due time to retry next tick, and count the failure so a persistently
  // broken automation still auto-disables after MAX_CONSECUTIVE_FAILURES instead
  // of retry-looping forever. `a.nextRunAt` is the pre-advance due time (mapped
  // from the SELECT snapshot, untouched by the UPDATE above).
  for (const { row: a, tickTs: ts } of claimed) {
    try {
      await fireAutomation(a);
    } catch (e) {
      log.error("automation fire failed", { automationId: a.id, err: String(e) });
      // Re-arm for retry ONLY if nobody changed the row since this tick stamped it
      // (updated_at still equals our tickTs). If the user paused or deleted it while
      // the fire was in flight, its updated_at moved (the pause/delete API bumps it)
      // — so the CAS misses and we leave their intent alone instead of resurrecting
      // a paused automation. Raw query so the timestamp param serializes exactly the
      // same way the tick wrote it (drizzle vs node-pg Date encoding otherwise differ
      // and the equality would never match).
      const { rows: upd } = await pool
        .query<{ consecutive_failures: number }>(
          `UPDATE automations
              SET next_run_at = $2, enabled = true,
                  consecutive_failures = consecutive_failures + 1, updated_at = $3
            WHERE id = $1 AND updated_at = $4
          RETURNING consecutive_failures`,
          [a.id, a.nextRunAt, new Date(), ts],
        )
        .catch(() => ({ rows: [] as { consecutive_failures: number }[] }));
      if (upd[0] && upd[0].consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
        await db.update(automations).set({ enabled: false, updatedAt: new Date() })
          .where(eq(automations.id, a.id)).catch(() => {});
      }
    }
  }
}
