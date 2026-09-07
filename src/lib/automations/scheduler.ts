import { eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
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
  // The admin's global switch has to be read HERE, not only at creation time: it
  // was gating `add` alone, so turning automations off left every existing one
  // firing on the shared key. It is a temporary platform-wide stop, so rows are
  // left enabled and simply not claimed — flipping it back on resumes them.
  if (((await getSetting("automations_enabled")) ?? "true") !== "true") return;

  const client = await pool.connect();
  // Each claimed row is tagged with the exact updated_at this tick stamped on it,
  // so the error-recovery below can tell "nobody touched it" from "the user paused
  // or deleted it mid-fire" via a CAS on updated_at (a JS-precision timestamp we
  // control, not now(), so it round-trips exactly for the compare).
  const claimed: Array<{ row: AutomationRow; tickTs: Date }> = [];
  const tickTs = new Date();
  try {
    await client.query("BEGIN");
    // Ownership is re-checked on EVERY firing, not just at creation: an automation
    // outlives the account that made it and the project it belongs to, and neither
    // revocation reaches back to it. `requireActive` only gates HTTP routes, so a
    // suspended user's schedule kept spending the admin's shared key with nobody
    // in session at all. Rows that fail the check are switched OFF here, in their
    // own statement, WITH the reason — a silent skip would look identical to a
    // scheduler that had stopped working, and would resume the moment nobody was
    // watching. next_run_at is deliberately untouched: the row is off, and its due
    // time is recomputed from `now` if a human ever enables it again. Reactivation
    // does NOT re-arm it — the person sees the reason and decides.
    // Webhook rows are outside this statement's reach (next_run_at IS NULL never
    // satisfies `<= now`), which is why the hook route repeats the same check and
    // writes the same reason itself — see src/app/api/hooks/automations.
    await client.query(
      `UPDATE automations a
          SET enabled = false,
              disabled_reason = CASE WHEN u.status <> 'active' THEN 'owner_suspended' ELSE 'project_deleted' END,
              updated_at = $2
         FROM "user" u
        WHERE u.id = a.user_id
          AND a.enabled = true AND a.next_run_at <= $1
          AND (u.status <> 'active'
               OR (a.project_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = a.project_id AND p.deleted_at IS NULL)))`,
      [now, tickTs],
    );
    // The claim is the enforcement, the UPDATE above is only the explanation: an
    // ineligible row must not be claimable even if that statement failed to match
    // it. FOR UPDATE OF a — a LEFT-JOINed table cannot be locked, and only the
    // automation row is being claimed anyway.
    const { rows } = await client.query(
      `SELECT a.* FROM automations a
         JOIN "user" u ON u.id = a.user_id
         LEFT JOIN projects p ON p.id = a.project_id AND p.deleted_at IS NULL
        WHERE a.enabled = true AND a.next_run_at <= $1
          AND u.status = 'active'
          AND (a.project_id IS NULL OR p.id IS NOT NULL)
        ORDER BY a.next_run_at
        LIMIT 20
        FOR UPDATE OF a SKIP LOCKED`,
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
        // once-triggers naturally finish here: no next occurrence means done, so
        // the row switches itself off. A webhook trigger ALSO has no next
        // occurrence and must not be read that way — it is only ever fired by an
        // HTTP call, so "no clock" is its normal state, not its end. Its
        // next_run_at is NULL, which already keeps it out of the claim above; this
        // is the second lock on the same door, because the failure mode (an
        // automation switching itself off the first tick after it was created) is
        // silent and the door is one predicate away from opening.
        [raw.id, next, next !== null || trigger.kind === "webhook", tickTs],
      );
      claimed.push({
        row: {
          ...raw,
          // pg returns snake_case — map the fields fireAutomation reads:
          userId: raw.user_id, projectId: raw.project_id, lastTaskId: raw.last_task_id,
          lastRunAt: raw.last_run_at, nextRunAt: raw.next_run_at,
          consecutiveFailures: raw.consecutive_failures, createdAt: raw.created_at, updatedAt: tickTs,
          maxRunsPerDay: raw.max_runs_per_day,
          threadMode: raw.thread_mode, threadChatId: raw.thread_chat_id,
          // The condition gate reads this on every firing, so an unmapped column
          // would leave `run_when` inert for scheduled runs while still working
          // for webhooks and "Run now" — a gate that silently applies to two of
          // three trigger kinds.
          runWhen: raw.run_when,
          // runs_day / runs_today are deliberately NOT mapped: node-pg decodes a
          // `date` column to a JS Date while drizzle hands back the string this
          // code compares, and fireAutomation re-reads both fresh anyway. A
          // mapped-but-wrongly-typed field behind an `as` cast is a trap.
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
