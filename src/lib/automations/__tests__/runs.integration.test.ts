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

// The daily cap and the standing thread live in SQL — a stamped day compared in a
// single UPDATE, and a message chained onto a chat's live leaf. A mocked db could
// only assert that the code called itself; these need a real one.
run("max_runs_per_day and thread_mode single", () => {
  const U2 = "atest-user-2";

  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'B','b@test.local') ON CONFLICT (id) DO NOTHING`, [U2]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U2]);
  });
  afterAll(async () => {
    const { rows } = await pool.query<{ chat_id: string }>(`SELECT chat_id FROM tasks WHERE user_id = $1`, [U2]);
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U2]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U2]);
    for (const { chat_id } of rows) await pool.query(`DELETE FROM chats WHERE id = $1`, [chat_id]);
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U2]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U2]);
  });

  it("the cap skips a firing, counts the skip, and is NOT a failure", async () => {
    const { db } = await import("@/lib/db");
    const { automations, tasks } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");
    const { localDayOf } = await import("../schedule");

    const capId = nanoid();
    await db.insert(automations).values({
      id: capId, userId: U2, title: "Capped", prompt: "go",
      trigger: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" },
      maxRunsPerDay: 1,
    });
    const [first] = await db.select().from(automations).where(eq(automations.id, capId));
    expect((await fireAutomation(first)).fired).toBe(true);

    const [stamped] = await db.select().from(automations).where(eq(automations.id, capId));
    expect(stamped.runsToday).toBe(1);
    expect(stamped.runsDay).toBe(localDayOf(stamped.trigger as { timezone: string }));

    // The cap is checked BEFORE the overlap guard, so a capped automation reports
    // the ceiling and not "the previous run is still live". The reason the webhook
    // returns and the settings list shows has to be the real one.
    expect(await fireAutomation(stamped)).toEqual({ fired: false, reason: "daily_limit" });

    const [after] = await db.select().from(automations).where(eq(automations.id, capId));
    expect(after.skippedToday).toBe(1);
    expect(after.enabled).toBe(true);            // a ceiling never disables
    expect(after.consecutiveFailures).toBe(0);   // and never counts as a failure

    // Bypassed for a human pressing "Run now": that run is attended, and a cap
    // that blocked it would make a capped automation impossible to test on the
    // very day it needs testing. The bypass is about the CAP only — the overlap
    // guard still applies, so the first run's task has to be finished first (no
    // worker drains it here).
    await db.update(tasks).set({ status: "completed" }).where(eq(tasks.id, after.lastTaskId!));
    expect((await fireAutomation(after, { bypassDailyCap: true })).fired).toBe(true);
  });

  it("rolls over: yesterday's tallies neither block today nor survive the firing", async () => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");

    const rollId = nanoid();
    await db.insert(automations).values({
      id: rollId, userId: U2, title: "Rolled", prompt: "go",
      trigger: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" },
      maxRunsPerDay: 1,
    });
    // A day the automation had already exhausted. Nothing runs at midnight to
    // clear this — the next firing's own UPDATE is what resets it.
    await pool.query(
      `UPDATE automations SET runs_day = current_date - 1, runs_today = 9, skipped_today = 4 WHERE id = $1`,
      [rollId],
    );
    const [row] = await db.select().from(automations).where(eq(automations.id, rollId));
    expect((await fireAutomation(row)).fired).toBe(true);

    const [after] = await db.select().from(automations).where(eq(automations.id, rollId));
    expect(after.runsToday).toBe(1);     // not 10 — the stamped day changed
    expect(after.skippedToday).toBe(0);  // yesterday's skips are not today's
  });

  it("single mode appends to ONE chat, quotes a webhook body as untrusted, and does not skip a live run", async () => {
    const { db } = await import("@/lib/db");
    const { automations, chats, messages } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");

    const singleId = nanoid();
    await db.insert(automations).values({
      id: singleId, userId: U2, title: "Standing thread", prompt: "check in",
      trigger: { kind: "webhook", timezone: "UTC" }, threadMode: "single",
      webhookToken: nanoid(),
    });
    const [a1] = await db.select().from(automations).where(eq(automations.id, singleId));
    const first = await fireAutomation(a1, { rawBody: '{"x":1}' });
    expect(first.fired).toBe(true);

    const [afterFirst] = await db.select().from(automations).where(eq(automations.id, singleId));
    expect(afterFirst.threadChatId).toBe(first.chatId);
    const [chat] = await db.select().from(chats).where(eq(chats.id, first.chatId!));
    expect(chat.title).toBe("Standing thread"); // a standing thread gets no date suffix

    const opening = await db.select().from(messages).where(eq(messages.chatId, first.chatId!));
    expect(opening).toHaveLength(1);
    expect(opening[0].content).toContain("check in");
    expect(opening[0].content).toContain("untrusted data");
    expect(opening[0].content).toContain('"x": 1'); // JSON body pretty-printed
    // The mark, not just the wording: every downstream fold reads this column.
    expect(opening[0].untrustedIngress).toBe(true);

    // Its task is still queued. In `fresh` mode that skips the occurrence; here it
    // must append and let the turn fold, which is the whole point of a thread.
    const second = await fireAutomation(afterFirst);
    expect(second).toEqual({ fired: true, chatId: first.chatId });
    const [chatAfter] = await db.select().from(chats).where(eq(chats.id, first.chatId!));
    const [leaf] = await db.select().from(messages).where(eq(messages.id, chatAfter.activeLeafId!));
    expect(leaf.parentId).toBe(opening[0].id); // chained, so the tree stays linear
    expect(leaf.untrustedIngress).toBe(false); // no body on this firing

    // A deleted thread must not wedge the automation: the next firing opens a new
    // one rather than failing on a dangling id.
    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [first.chatId]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [first.chatId]);
    const [orphaned] = await db.select().from(automations).where(eq(automations.id, singleId));
    const third = await fireAutomation(orphaned);
    expect(third.fired).toBe(true);
    expect(third.chatId).not.toBe(first.chatId);
    const [reopened] = await db.select().from(automations).where(eq(automations.id, singleId));
    expect(reopened.threadChatId).toBe(third.chatId);
  });
});
