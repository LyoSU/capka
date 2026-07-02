import { pool } from "@/lib/db";
import { nextOccurrenceAfter, type AutomationTrigger } from "./schedule";
import { fireAutomation, type AutomationRow } from "./runs";
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
  const claimed: AutomationRow[] = [];
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
        `UPDATE automations SET next_run_at = $2, enabled = $3, updated_at = now() WHERE id = $1`,
        [raw.id, next, next !== null], // once-triggers naturally finish here
      );
      claimed.push({
        ...raw,
        // pg returns snake_case — map the fields fireAutomation reads:
        userId: raw.user_id, projectId: raw.project_id, lastTaskId: raw.last_task_id,
        lastRunAt: raw.last_run_at, nextRunAt: raw.next_run_at,
        consecutiveFailures: raw.consecutive_failures, createdAt: raw.created_at, updatedAt: raw.updated_at,
      } as AutomationRow);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log.error("scheduler tick failed", { err: String(e) });
    return;
  } finally {
    client.release();
  }
  // Fire AFTER commit so a slow/failed materialization can't hold row locks.
  for (const a of claimed) {
    await fireAutomation(a).catch((e) => log.error("automation fire failed", { automationId: a.id, err: String(e) }));
  }
}
