import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { automations, chats, tasks } from "@/lib/db/schema";
import { localDayOf } from "../schedule";
import { fireAutomation, DEFAULT_WEBHOOK_RUNS_PER_DAY } from "../runs";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... vitest run runs-limits.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "alimit-user";

// Same stub the neighbouring runs.integration suite uses: an own-key user, so the
// budget gate never refuses and no hold is taken against a provider CI lacks.
vi.mock("@/lib/providers/resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/resolve")>();
  return {
    ...actual,
    resolveUserModelInfo: vi.fn(async () => ({
      model: "alimit-model", provider: "openai", modelId: "alimit-model",
      configId: null, isShared: false, modelInput: null, apiStyle: "chat" as const,
    })),
  };
});

const WEBHOOK = { kind: "webhook" as const, timezone: "Europe/Kyiv" };

run("fireAutomation: the daily ceiling is an invariant, and a webhook always has one", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'A','alimit@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
  });

  async function wipe() {
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
  }
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  async function insert(overrides: Partial<typeof automations.$inferInsert> = {}): Promise<string> {
    const id = nanoid();
    await db.insert(automations).values({
      id, userId: U, title: "Ping", prompt: "Handle the ping",
      trigger: WEBHOOK, webhookToken: nanoid(),
      ...overrides,
    });
    return id;
  }

  async function load(id: string) {
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    return row;
  }

  it("two concurrent firings of a capped single-thread automation make one run and one thread", async () => {
    const id = await insert({ threadMode: "single", maxRunsPerDay: 1 });
    const a = await load(id);

    // Both calls hold the same row snapshot, exactly as two webhook POSTs arriving
    // together do. Before the row lock both passed the ceiling read, both saw
    // thread_chat_id NULL, and both ran and opened a thread of their own.
    const results = await Promise.all([
      fireAutomation(a, { rawBody: "{}" }),
      fireAutomation(a, { rawBody: "{}" }),
    ]);

    const fired = results.filter((r) => r.fired);
    expect(fired).toHaveLength(1);
    expect(results.find((r) => !r.fired)?.reason).toBe("daily_limit");

    const row = await load(id);
    expect(row.runsToday).toBe(1);
    // One thread, and it is the one the winning firing actually wrote into.
    expect(row.threadChatId).toBe(fired[0].chatId);
    expect(await db.select({ id: chats.id }).from(chats).where(eq(chats.userId, U))).toHaveLength(1);
    expect(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.userId, U))).toHaveLength(1);
  });

  it("two concurrent firings with no ceiling still share one single-mode thread", async () => {
    const id = await insert({ threadMode: "single" });
    const a = await load(id);

    const results = await Promise.all([
      fireAutomation(a, { rawBody: "{}" }),
      fireAutomation(a, { rawBody: "{}" }),
    ]);

    // Both are allowed to run — nothing caps them at two — but "one ongoing chat"
    // is the promise of `single` mode, so the second lands in the first one's
    // thread instead of opening a second one that nothing points at.
    expect(results.every((r) => r.fired)).toBe(true);
    expect(results[0].chatId).toBe(results[1].chatId);
    expect((await load(id)).threadChatId).toBe(results[0].chatId);
    expect(await db.select({ id: chats.id }).from(chats).where(eq(chats.userId, U))).toHaveLength(1);
  });

  it("a webhook with no max_runs_per_day still stops at the platform default", async () => {
    const id = await insert({ runsDay: localDayOf(WEBHOOK), runsToday: DEFAULT_WEBHOOK_RUNS_PER_DAY });
    const res = await fireAutomation(await load(id), { rawBody: "{}" });

    expect(res.fired).toBe(false);
    expect(res.reason).toBe("daily_limit");
    // Visible, not merely refused: the settings list reads this to explain a quiet
    // automation, and the hook's 202 reports the same reason.
    expect((await load(id)).lastSkip).toMatchObject({ reason: "daily_limit" });
  });

  it("a SCHEDULE with no max_runs_per_day has no such ceiling — its clock is the ceiling", async () => {
    const trigger = { kind: "schedule" as const, cron: "0 9 * * 1", timezone: "Europe/Kyiv" };
    const id = await insert({
      trigger, webhookToken: null,
      runsDay: localDayOf(trigger), runsToday: DEFAULT_WEBHOOK_RUNS_PER_DAY,
    });

    expect((await fireAutomation(await load(id))).fired).toBe(true);
  });

  it('"Run now" is not held by the platform default either', async () => {
    const id = await insert({ runsDay: localDayOf(WEBHOOK), runsToday: DEFAULT_WEBHOOK_RUNS_PER_DAY });
    expect((await fireAutomation(await load(id), { manual: true })).fired).toBe(true);
  });
});
