import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { pool } from "../../db";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run runs.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "atest-user";

run("fireAutomation / recordAutomationOutcome", () => {
  let id: string;

  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'A','a@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
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

  it("materializes a run: new chat + user message + queued task, lastTaskId set", async () => {
    const { db } = await import("@/lib/db");
    const { automations, chats, messages, tasks } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");
    id = nanoid();
    await db.insert(automations).values({
      id, userId: U, title: "Weekly digest", prompt: "Prepare the digest",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
    });
    const [a] = await db.select().from(automations).where(eq(automations.id, id));
    expect((await fireAutomation(a)).fired).toBe(true);

    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.lastTaskId).toBeTruthy();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.lastTaskId!));
    expect(task.status).toBe("queued");
    const [msg] = await db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(msg.content).toBe("Prepare the digest");
    expect(msg.platform).toBe("automation");
    const [chat] = await db.select().from(chats).where(eq(chats.id, task.chatId));
    expect(chat.title).toContain("Weekly digest");
  });

  it("skips the firing while the previous run is still queued", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");
    const [a] = await db.select().from(automations).where(eq(automations.id, id));
    expect((await fireAutomation(a)).fired).toBe(false);
  });

  it("3 consecutive failures auto-disable", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { recordAutomationOutcome } = await import("../runs");
    await recordAutomationOutcome(id, "failed");
    await recordAutomationOutcome(id, "failed");
    await recordAutomationOutcome(id, "failed");
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.enabled).toBe(false);
    expect(row.consecutiveFailures).toBe(3);
  });

  it("completed resets the streak", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { recordAutomationOutcome } = await import("../runs");
    await recordAutomationOutcome(id, "completed");
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.consecutiveFailures).toBe(0);
  });

  it("a suspended run neither resets nor increments the streak (it's not success or failure)", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { recordAutomationOutcome } = await import("../runs");
    await db.update(automations).set({ consecutiveFailures: 2 }).where(eq(automations.id, id));
    await recordAutomationOutcome(id, "suspended");
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    expect(row.consecutiveFailures).toBe(2); // untouched — not reset, not incremented
  });

  it("skips a new firing while the previous run is awaiting the user's input, then fires once unblocked", async () => {
    const { db } = await import("@/lib/db");
    const { automations, tasks, messages } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");

    // Simulate the previous run FINISHING but suspended on an `ask`: task row
    // "completed", its reply message flagged awaiting_answer.
    const [row0] = await db.select().from(automations).where(eq(automations.id, id));
    const lastTaskId = row0.lastTaskId!;
    const [task] = await db.select().from(tasks).where(eq(tasks.id, lastTaskId));
    await db.update(tasks).set({ status: "completed" }).where(eq(tasks.id, lastTaskId));
    const replyId = nanoid();
    await db.insert(messages).values({
      id: replyId, chatId: task.chatId, parentId: null, role: "assistant",
      content: "", metadata: { status: "awaiting_answer" },
    });

    const [blockedRow] = await db.select().from(automations).where(eq(automations.id, id));
    expect((await fireAutomation(blockedRow)).fired).toBe(false); // blocked while awaiting

    // The user answers → the resume flips the reply's status away from awaiting_*.
    await db.update(messages).set({ metadata: { status: "completed" } }).where(eq(messages.id, replyId));
    const [unblockedRow] = await db.select().from(automations).where(eq(automations.id, id));
    expect((await fireAutomation(unblockedRow)).fired).toBe(true); // free to run again
  });

  it("a refused budget skips the run, leaves no chat behind, and counts toward the auto-disable", async () => {
    const { db } = await import("@/lib/db");
    const { automations, chats } = await import("@/lib/db/schema");
    const limits = await import("@/lib/billing/limits");
    const { fireAutomation, MAX_CONSECUTIVE_FAILURES } = await import("../runs");

    // One short of the threshold, so this refusal is the strike that trips it.
    const priorFailures = MAX_CONSECUTIVE_FAILURES - 1;
    const budgetId = nanoid();
    await db.insert(automations).values({
      id: budgetId, userId: U, title: "Over the limit", prompt: "spend",
      trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
      consecutiveFailures: priorFailures,
    });
    const before = (await db.select().from(chats).where(eq(chats.userId, U))).length;
    const spy = vi.spyOn(limits, "reserveBudget").mockResolvedValue({ allowed: false, window: "m1", reason: "budget" });
    try {
      const [row] = await db.select().from(automations).where(eq(automations.id, budgetId));
      expect((await fireAutomation(row)).fired).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // The gate is BEFORE any write: a refused run must not leave an orphan chat
    // holding a question nobody will answer.
    expect((await db.select().from(chats).where(eq(chats.userId, U))).length).toBe(before);
    const [after] = await db.select().from(automations).where(eq(automations.id, budgetId));
    expect(after.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    // Third strike — the same mechanism a broken automation trips, but the reason
    // recorded says budget, not "go read the last run's chat" (there isn't one).
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toBe("budget_exhausted");
  });
});
