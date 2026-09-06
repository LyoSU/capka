import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { pool } from "../../db";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run scheduler.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "atest-scheduler-user";
// A second owner, suspended: the eligibility re-check is about the account, so it
// cannot be exercised on the user every other test here needs active.
const SUSPENDED = "atest-scheduler-suspended";
const TOMBSTONED_PROJECT = "atest-scheduler-dead-project";

run("schedulerTick", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'A','a-scheduler@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(
      `INSERT INTO "user" (id, name, email, status) VALUES ($1,'S','s-scheduler@test.local','suspended')
         ON CONFLICT (id) DO UPDATE SET status = 'suspended'`,
      [SUSPENDED],
    );
    await pool.query(
      `INSERT INTO projects (id, user_id, name, deleted_at) VALUES ($1,$2,'Dead',now())
         ON CONFLICT (id) DO UPDATE SET deleted_at = now()`,
      [TOMBSTONED_PROJECT, U],
    );
    await pool.query(`DELETE FROM automations WHERE user_id = ANY($1)`, [[U, SUSPENDED]]);
  });
  afterAll(async () => {
    const { rows } = await pool.query<{ chat_id: string }>(
      `SELECT chat_id FROM tasks WHERE user_id = ANY($1)`,
      [[U, SUSPENDED]],
    );
    await pool.query(`DELETE FROM tasks WHERE user_id = ANY($1)`, [[U, SUSPENDED]]);
    await pool.query(`DELETE FROM automations WHERE user_id = ANY($1)`, [[U, SUSPENDED]]);
    for (const { chat_id } of rows) {
      await pool.query(`DELETE FROM chats WHERE id = $1`, [chat_id]);
    }
    await pool.query(`DELETE FROM projects WHERE id = $1`, [TOMBSTONED_PROJECT]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[U, SUSPENDED]]);
  });

  it("claims a due automation, fires it, and advances next_run_at", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    await db.insert(automations).values({
      id, userId: U, title: "Due now", prompt: "go",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      nextRunAt: new Date(Date.now() - 60_000), // already due
    });
    await schedulerTick();
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeTruthy(); // fired
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now()); // advanced, no backfill
  });

  it("a due once-trigger fires exactly once and finishes disabled", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    await db.insert(automations).values({
      id, userId: U, title: "One-off", prompt: "go",
      trigger: { kind: "once", at: new Date(Date.now() - 60_000).toISOString(), timezone: "Europe/Kyiv" },
      nextRunAt: new Date(Date.now() - 60_000),
    });
    await schedulerTick();
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeTruthy();
    expect(row.enabled).toBe(false);
    expect(row.nextRunAt).toBeNull();
  });

  it("restores the due time and counts a failure when firing throws", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const runs = await import("../runs");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: U, title: "Broken", prompt: "go",
      trigger: { kind: "once", at: due.toISOString(), timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    // Fail at the fire boundary, after the scheduler has validly claimed and
    // advanced the row. The old fixture used an invalid project FK and failed
    // during setup, so it never exercised recovery at all.
    const spy = vi.spyOn(runs, "fireAutomation").mockRejectedValue(new Error("boom"));
    try {
      await schedulerTick();
    } finally {
      spy.mockRestore();
    }
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeNull(); // never fired
    expect(row.enabled).toBe(true); // re-enabled for retry (not silently dropped)
    expect(row.nextRunAt!.getTime()).toBe(due.getTime()); // due time restored
    expect(row.consecutiveFailures).toBe(1);
  });

  it("recovery does NOT resurrect an automation the user paused during the fire", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const runs = await import("../runs");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: U, title: "Paused mid-fire", prompt: "go",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    // Simulate the user pausing the automation WHILE it fires: the fire flips
    // enabled=false (as the pause API would) and then throws. The error-recovery
    // must respect that pause, not blindly re-enable it.
    const spy = vi.spyOn(runs, "fireAutomation").mockImplementation(async () => {
      await db.update(automations).set({ enabled: false, updatedAt: new Date() }).where(eq(automations.id, id));
      throw new Error("boom");
    });
    try {
      await schedulerTick();
    } finally {
      spy.mockRestore();
    }
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.enabled).toBe(false); // pause honored, NOT resurrected by recovery
  });

  it("recovery DOES re-arm for retry when the fire throws and nobody intervened", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const runs = await import("../runs");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: U, title: "Transient failure", prompt: "go",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    const spy = vi.spyOn(runs, "fireAutomation").mockRejectedValue(new Error("boom"));
    try {
      await schedulerTick();
    } finally {
      spy.mockRestore();
    }
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    // No user intervention → the CAS matches, so the occurrence is retried:
    expect(row.enabled).toBe(true);
    expect(row.nextRunAt!.getTime()).toBe(due.getTime()); // due time restored
    expect(row.consecutiveFailures).toBe(1);
  });

  it("not-due and disabled rows are untouched", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { schedulerTick } = await import("../scheduler");
    const futureId = nanoid();
    const disabledId = nanoid();
    await db.insert(automations).values([
      {
        id: futureId, userId: U, title: "Future", prompt: "go",
        trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
        nextRunAt: new Date(Date.now() + 60 * 60_000), // an hour from now
      },
      {
        id: disabledId, userId: U, title: "Disabled", prompt: "go",
        trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
        nextRunAt: new Date(Date.now() - 60_000), // due, but disabled
        enabled: false,
      },
    ]);
    await schedulerTick();
    const [future] = await db.select().from(automations).where(eq(automations.id, futureId));
    const [disabled] = await db.select().from(automations).where(eq(automations.id, disabledId));
    expect(future.lastTaskId).toBeNull();
    expect(disabled.lastTaskId).toBeNull();
  });

  it("a suspended owner's due automation is not claimed — it is switched off with the reason, due time untouched", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: SUSPENDED, title: "Owned by a suspended account", prompt: "go",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    await schedulerTick();
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeNull(); // never fired
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe("owner_suspended");
    // Not claimed means not advanced: a skipped occurrence must not silently
    // consume the schedule the way a fired one does.
    expect(row.nextRunAt!.getTime()).toBe(due.getTime());

    // Reactivating the account does NOT resume unattended spending on its own —
    // the person reads the reason and switches it back on deliberately.
    await pool.query(`UPDATE "user" SET status = 'active' WHERE id = $1`, [SUSPENDED]);
    try {
      await schedulerTick();
      const [afterReactivation] = await db.select().from(automations).where(eq(automations.id, id));
      expect(afterReactivation.enabled).toBe(false);
      expect(afterReactivation.lastTaskId).toBeNull();
      expect(afterReactivation.disabledReason).toBe("owner_suspended");
    } finally {
      await pool.query(`UPDATE "user" SET status = 'suspended' WHERE id = $1`, [SUSPENDED]);
    }
  });

  it("an automation whose project is tombstoned is not claimed — switched off as project_deleted", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: U, projectId: TOMBSTONED_PROJECT, title: "Project being deleted", prompt: "go",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    await schedulerTick();
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeNull();
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe("project_deleted");
    expect(row.nextRunAt!.getTime()).toBe(due.getTime());
  });

  it("the platform switch off stops the tick without disabling anything (it is temporary)", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { getSetting, setSetting } = await import("@/lib/settings");
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: U, title: "Due while the platform switch is off", prompt: "go",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    // Restore the row to whatever it was — this is a shared dev database and an
    // absent key is not the same state as an explicit "true".
    const prior = await getSetting("automations_enabled");
    await setSetting("automations_enabled", "false");
    try {
      await schedulerTick();
    } finally {
      if (prior === null) await pool.query(`DELETE FROM settings WHERE key = 'automations_enabled'`);
      else await setSetting("automations_enabled", prior);
    }
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeNull(); // did not run
    expect(row.nextRunAt!.getTime()).toBe(due.getTime()); // did not advance
    // Still armed: the switch is the admin pausing the platform, not a verdict on
    // this automation, so flipping it back on must resume it with no user action.
    expect(row.enabled).toBe(true);
    expect(row.disabledReason).toBeNull();
  });
});
