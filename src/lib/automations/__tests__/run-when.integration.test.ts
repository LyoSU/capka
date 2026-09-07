import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { pool } from "../../db";

/**
 * The condition gate as `fireAutomation` actually runs it.
 *
 * Mocked: the LLM call (there is no verdict to test, only what we do with one)
 * and the model resolution (a test box has no provider connection). Everything
 * else is the real thing, because everything else is SQL: the skip tally's day
 * comparison, the `last_skip` stamp, the released budget hold, and the fact that
 * a refused firing writes NO chat. A mocked db could only assert that the code
 * called itself.
 *
 * Opt-in: RUN_INTEGRATION=1 npx vitest run run-when.integration
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "runwhen-user";
const CFG = "runwhen-config";

const { auxGenerate } = vi.hoisted(() => ({ auxGenerate: vi.fn() }));

vi.mock("@/lib/chat/context/aux", () => ({
  auxGenerate,
  AUX_TIMEOUT_MS: 180_000,
  buildAuxRequest: vi.fn(),
}));

// `isShared: true` deliberately: an own-key user is never gated and never held,
// so the "hold released" assertion below would pass without a hold ever existing.
vi.mock("@/lib/providers/resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/resolve")>();
  const turn = {
    model: "gate-test-model", provider: "openai", modelId: "gate-test-model",
    configId: CFG, isShared: true, modelInput: null, apiStyle: "chat" as const,
  };
  return {
    ...actual,
    resolveUserModelInfo: vi.fn(async () => turn),
    // The pick rule itself is unit-tested (pickAuxTarget); here the gate simply
    // runs where the automation runs.
    resolveAuxTarget: vi.fn(async (_userId: string, t: unknown) => t),
  };
});

const verdict = (text: string) => ({
  text,
  usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
});

run("fireAutomation + run_when", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'RW','rw@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    // A real connection row, so the gate's ledger insert (config_id is a FK)
    // actually lands instead of being swallowed as non-fatal.
    await pool.query(
      `INSERT INTO provider_configs (id, user_id, provider, default_model) VALUES ($1,$2,'openai','gate-test-model')
         ON CONFLICT (id) DO NOTHING`,
      [CFG, U],
    );
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U]);
  });

  afterAll(async () => {
    const { rows } = await pool.query<{ chat_id: string }>(`SELECT chat_id FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM automations WHERE user_id = $1`, [U]);
    for (const { chat_id } of rows) await pool.query(`DELETE FROM chats WHERE id = $1`, [chat_id]);
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM provider_configs WHERE id = $1`, [CFG]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  beforeEach(() => {
    auxGenerate.mockReset();
  });

  const seed = async (runWhen: string | null) => {
    const { db } = await import("@/lib/db");
    const { automations } = await import("@/lib/db/schema");
    const id = nanoid();
    await db.insert(automations).values({
      id, userId: U, title: "Order digest", prompt: "Summarize the new orders",
      trigger: { kind: "webhook", timezone: "UTC" }, webhookToken: nanoid(),
      runWhen,
    });
    const [row] = await db.select().from(automations).where(eq(automations.id, id));
    return row;
  };

  it("a NO verdict skips the firing: counted, explained, no chat, no held budget", async () => {
    const { db } = await import("@/lib/db");
    const { automations, chats, usage } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");
    const { localDayOf } = await import("../schedule");

    auxGenerate.mockResolvedValue(verdict("NO\nThe body carries no new orders."));
    const a = await seed("only when there is at least one new order in the body");
    const chatsBefore = (await db.select().from(chats).where(eq(chats.userId, U))).length;

    const res = await fireAutomation(a, { rawBody: '{"orders":[]}' });
    expect(res.fired).toBe(false);
    expect(res.reason).toBe("condition");
    expect(res.note).toBe("The body carries no new orders.");

    // A skip, not a failure — the same contract the daily cap has.
    const [after] = await db.select().from(automations).where(eq(automations.id, a.id));
    expect(after.skippedToday).toBe(1);
    expect(after.runsToday).toBe(0);
    expect(after.runsDay).toBe(localDayOf({ timezone: "UTC" }));
    expect(after.enabled).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastTaskId).toBeNull();

    // Counted AND explained: which of the three refusals it was, and why.
    const skip = after.lastSkip as { reason: string; at: string; note?: string };
    expect(skip.reason).toBe("condition");
    expect(skip.note).toBe("The body carries no new orders.");
    expect(Number.isFinite(Date.parse(skip.at))).toBe(true);

    // The gate runs BEFORE anything is written, so a refused firing leaves no
    // chat holding an instruction nobody will answer.
    expect((await db.select().from(chats).where(eq(chats.userId, U))).length).toBe(chatsBefore);

    // The gate's own spend is on the ledger under its own purpose — a background
    // call that decides whether to spend must not itself be invisible.
    const rows = await db.select().from(usage).where(eq(usage.userId, U));
    const gate = rows.filter((r) => r.purpose === "run_when");
    expect(gate).toHaveLength(1);
    expect(gate[0].inputTokens).toBe(120);
    expect(gate[0].outputTokens).toBe(8);
    expect(gate[0].messageId).toBeNull(); // there is no message at gate time
    // And the hold reserved for the run that never happened is gone: leaking it
    // would inflate the user's budget forever, with no task row for the zombie
    // reconciler to find.
    expect(rows.filter((r) => r.pending)).toHaveLength(0);
  });

  it("the model actually saw the condition and the untrusted event", async () => {
    const { fireAutomation } = await import("../runs");
    auxGenerate.mockResolvedValue(verdict("NO\nnope"));
    const a = await seed("only when the payment failed");
    await fireAutomation(a, { rawBody: '{"event":"payment_failed"}' });

    const [, , args] = auxGenerate.mock.calls[0];
    expect(args.prompt).toContain("only when the payment failed");
    expect(args.prompt).toContain("payment_failed");
    expect(args.prompt).toMatch(/UNTRUSTED/);
    expect(args.system).toMatch(/YES/);
  });

  it("a YES verdict fires normally", async () => {
    const { db } = await import("@/lib/db");
    const { automations, messages, tasks } = await import("@/lib/db/schema");
    const { fireAutomation } = await import("../runs");

    auxGenerate.mockResolvedValue(verdict("YES\nTwo new orders."));
    const a = await seed("only when there is at least one new order");
    const res = await fireAutomation(a, { rawBody: '{"orders":[1,2]}' });
    expect(res.fired).toBe(true);

    const [after] = await db.select().from(automations).where(eq(automations.id, a.id));
    expect(after.runsToday).toBe(1);
    expect(after.skippedToday).toBe(0);
    expect(after.lastTaskId).toBeTruthy();
    // The task ROW, not its status: the dev container runs a live worker that
    // claims a queued task within its poll interval, so "queued" is a moment and
    // asserting it makes this test a coin flip. That a turn exists to answer the
    // firing is the durable property.
    const [task] = await db.select().from(tasks).where(eq(tasks.id, after.lastTaskId!));
    expect(task).toBeTruthy();
    const [msg] = await db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(msg.content).toContain("Summarize the new orders");
  });

  it("a broken gate runs the automation anyway (fail-open) and says so", async () => {
    const { fireAutomation } = await import("../runs");
    auxGenerate.mockRejectedValue(new Error("provider is down"));
    const a = await seed("only on working days");
    expect((await fireAutomation(a)).fired).toBe(true);

    // Same for an answer with no verdict in it: never guess "no", because a
    // guessed no is an automation that stops firing with nothing to explain it.
    auxGenerate.mockResolvedValue(verdict("I am not sure about that."));
    const b = await seed("only on working days");
    expect((await fireAutomation(b)).fired).toBe(true);
  });

  it("\"Run now\" bypasses the gate, and no condition means no gate call at all", async () => {
    const { fireAutomation } = await import("../runs");

    auxGenerate.mockResolvedValue(verdict("NO\nnot today"));
    const a = await seed("only on the first of the month");
    expect((await fireAutomation(a, { manual: true })).fired).toBe(true);
    expect(auxGenerate).not.toHaveBeenCalled();

    // An automation without a condition must not pay for a model call to discover
    // it has none.
    const b = await seed(null);
    expect((await fireAutomation(b)).fired).toBe(true);
    expect(auxGenerate).not.toHaveBeenCalled();
  });
});
