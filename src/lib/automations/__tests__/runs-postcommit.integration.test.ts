import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { automations, chats, messages, tasks } from "@/lib/db/schema";
import { fireAutomation } from "../runs";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... vitest run runs-postcommit.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "apost-user";

// The two post-commit wake-ups, replaced so each can be made to fail. Everything
// else in both modules stays real — `enqueueTask` in particular, which is what
// actually writes the task row this file asserts on.
const { publishTaskEvent, notifyTaskEnqueued } = vi.hoisted(() => ({
  publishTaskEvent: vi.fn(),
  notifyTaskEnqueued: vi.fn(),
}));
vi.mock("@/lib/tasks/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tasks/events")>()),
  publishTaskEvent,
}));
vi.mock("@/lib/tasks/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tasks/queue")>()),
  notifyTaskEnqueued,
}));
vi.mock("@/lib/providers/resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/resolve")>();
  return {
    ...actual,
    resolveUserModelInfo: vi.fn(async () => ({
      model: "apost-model", provider: "openai", modelId: "apost-model",
      configId: null, isShared: false, modelInput: null, apiStyle: "chat" as const,
    })),
  };
});

run("fireAutomation: a committed firing is never reported as a failure", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'A','apost@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
  });

  async function wipe() {
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
  }
  beforeEach(async () => {
    await wipe();
    publishTaskEvent.mockReset().mockResolvedValue(undefined);
    notifyTaskEnqueued.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await wipe();
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  async function fire() {
    const id = nanoid();
    await db.insert(automations).values({
      id, userId: U, title: "Ping", prompt: "Handle the ping",
      trigger: { kind: "webhook", timezone: "Europe/Kyiv" }, webhookToken: nanoid(),
    });
    const [a] = await db.select().from(automations).where(eq(automations.id, id));
    return { id, res: await fireAutomation(a, { rawBody: "{}" }) };
  }

  /** Everything the firing wrote is committed and complete. */
  async function assertMaterialized(automationId: string, chatId: string | undefined) {
    expect(chatId).toBeTruthy();
    const [row] = await db.select().from(automations).where(eq(automations.id, automationId));
    expect(row.lastTaskId).toBeTruthy();
    expect(row.runsToday).toBe(1);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.lastTaskId!));
    expect(task.chatId).toBe(chatId);
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId!))).toHaveLength(1);
    expect(await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId!))).toHaveLength(1);
  }

  it("a failed new_message event does not turn a committed run into a throw", async () => {
    // The realtime publish is the FIRST thing after the commit. A throw here used
    // to propagate: the hook route treats a throw as "nothing was processed",
    // releases its idempotency claim and answers with an error — so the sender's
    // retry buys a second paid run for one event, on top of the one that already
    // ran.
    publishTaskEvent.mockRejectedValue(new Error("realtime down"));
    const { id, res } = await fire();

    expect(res.fired).toBe(true);
    await assertMaterialized(id, res.chatId);
    // Best-effort means the second wake-up still gets its turn.
    expect(notifyTaskEnqueued).toHaveBeenCalledTimes(1);
  });

  it("a failed worker wake-up does not either — the 5s poll finds the turn", async () => {
    notifyTaskEnqueued.mockRejectedValue(new Error("notify channel down"));
    const { id, res } = await fire();

    expect(res.fired).toBe(true);
    await assertMaterialized(id, res.chatId);
  });

  it("both failing still leaves one committed, complete firing", async () => {
    publishTaskEvent.mockRejectedValue(new Error("realtime down"));
    notifyTaskEnqueued.mockRejectedValue(new Error("notify channel down"));
    const { id, res } = await fire();

    expect(res.fired).toBe(true);
    await assertMaterialized(id, res.chatId);
  });

  it("the happy path still wakes both", async () => {
    const { res } = await fire();
    expect(res.fired).toBe(true);
    expect(publishTaskEvent).toHaveBeenCalledTimes(1);
    expect(notifyTaskEnqueued).toHaveBeenCalledTimes(1);
  });
});
