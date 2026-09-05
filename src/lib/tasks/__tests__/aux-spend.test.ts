import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `recordAuxSpend` is what makes a background call visible: one ledger row saying
 * WHAT it bought, and one entry on the message the user is looking at.
 *
 * The concurrency it exists for (three passes appending at once) is a property of
 * Postgres and is not testable here — what is testable, and is where a silent
 * regression would live, is that the append is expressed as a concatenation rather
 * than a read-modify-write, and that the entry's shape matches what the popover
 * reads.
 */
const { execute, recordUsage, resolveCost } = vi.hoisted(() => ({
  // The signature is given as a type argument rather than as unused parameters on
  // the implementation: an argument-less mock makes `mock.calls[0][0]` a zero-length
  // tuple, which every assertion below reads.
  execute: vi.fn<(query: unknown) => Promise<{ rows: never[] }>>(async () => ({ rows: [] })),
  recordUsage: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  resolveCost: vi.fn<(model: string, usage: unknown) => Promise<number | null>>(async () => 0.004),
}));

vi.mock("@/lib/db", () => ({ db: { execute } }));
vi.mock("@/lib/usage", () => ({ recordUsage }));
vi.mock("@/lib/pricing", () => ({ costUsd: resolveCost }));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { recordAuxSpend } from "../aux-spend";

const base = {
  taskId: "task-1",
  messageId: "msg-1",
  userId: "user-1",
  provider: "anthropic",
  configId: "cfg-1",
  model: "claude-opus-5",
  turnModel: "claude-opus-5",
  onSharedKey: true,
  purpose: "title" as const,
  usage: { inputTokens: 1200, outputTokens: 30, cachedInputTokens: 900 },
};

/** The metadata entry the UPDATE carried, parsed back out of its bound parameter.
 *  The parameter is a ONE-element array (that is what `||` concatenates onto the
 *  existing one), so the entry itself is its first element. */
function appendedEntry() {
  const query = execute.mock.calls[0]?.[0];
  const json = JSON.stringify(query).match(/\[\{\\"purpose\\":.*?\}\]/)?.[0];
  return json ? JSON.parse(json.replace(/\\"/g, '"'))[0] : null;
}

beforeEach(() => vi.clearAllMocks());

describe("recordAuxSpend", () => {
  it("bills the ledger with the purpose that says what the call bought", async () => {
    await recordAuxSpend(base);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      purpose: "title",
      taskId: "task-1",
      messageId: "msg-1",
      // Priced here and handed over, so the ledger doesn't pay for a second lookup.
      costUsd: 0.004,
    });
    expect(resolveCost).toHaveBeenCalledTimes(1);
  });

  it("appends to the message's aux array instead of reading it first", async () => {
    await recordAuxSpend(base);

    expect(execute).toHaveBeenCalledTimes(1);
    const sql = JSON.stringify(execute.mock.calls[0][0]);
    // The concatenation IS the concurrency fix: three passes are dispatched
    // together, so a JS-side read-then-write would drop two of the three entries.
    expect(sql).toContain("||");
    expect(sql).toContain("jsonb_set");
    expect(sql).not.toMatch(/SELECT\s+metadata/i);
  });

  it("folds cache writes into input and keeps cached reads separate", async () => {
    await recordAuxSpend({
      ...base,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, cacheWriteTokens: 25 },
    });

    expect(appendedEntry()).toMatchObject({ input: 125, output: 10, cached: 40 });
  });

  it("names the model only when the background call used a different one", async () => {
    await recordAuxSpend(base);
    expect(appendedEntry()).not.toHaveProperty("model");

    execute.mockClear();
    await recordAuxSpend({ ...base, model: "claude-haiku-4-5", turnModel: "claude-opus-5" });
    expect(appendedEntry()).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("still bills when the metadata append fails — the reply already shipped", async () => {
    execute.mockRejectedValueOnce(new Error("row is gone"));
    await expect(recordAuxSpend(base)).resolves.toBeUndefined();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("omits the cost when the catalog has no price for the model", async () => {
    resolveCost.mockRejectedValueOnce(new Error("no price"));
    await recordAuxSpend(base);

    expect(recordUsage.mock.calls[0][0]).toMatchObject({ costUsd: null });
    expect(appendedEntry()).not.toHaveProperty("costUsd");
  });
});
