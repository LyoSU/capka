import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { pool } from "../../db";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run scheduler.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "atest-scheduler-user";

run("schedulerTick", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'A','a-scheduler@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U]);
  });
  afterAll(async () => {
    const { rows } = await pool.query<{ chat_id: string }>(
      `SELECT chat_id FROM tasks WHERE user_id = $1`,
      [U],
    );
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U]);
    for (const { chat_id } of rows) {
      await pool.query(`DELETE FROM chats WHERE id = $1`, [chat_id]);
    }
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
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
    const { schedulerTick } = await import("../scheduler");
    const id = nanoid();
    const due = new Date(Date.now() - 60_000);
    await db.insert(automations).values({
      id, userId: U, title: "Broken", prompt: "go",
      // A non-existent projectId makes fireAutomation's chat insert violate the FK
      // and throw — the occurrence must NOT be lost: the due time is restored so
      // the next tick retries, and the failure counter advances toward auto-disable.
      projectId: "no-such-project",
      trigger: { kind: "once", at: due.toISOString(), timezone: "Europe/Kyiv" },
      nextRunAt: due,
    });
    await schedulerTick();
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
});
