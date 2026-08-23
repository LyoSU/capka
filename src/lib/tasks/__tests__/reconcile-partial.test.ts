import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A hard crash never reaches the runner's finalize, so the zombie reconciler — not
 * `interruptedError` — is what most interrupted turns are actually told. It wrote
 * one flat "interrupted" whatever the turn had left behind, which is the same
 * "start over" advice the timeout path just stopped giving. These pin the two
 * halves the SQL cannot check for itself: that the reconciler produces the partial
 * category at all, and that its sentences stay the friendly errors' own.
 */
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ pool: { query, connect: vi.fn() } }));
vi.mock("@/lib/realtime", () => ({ realtime: { publish: vi.fn(), subscribe: vi.fn() } }));

import { reconcileZombies, INTERRUPTED_MESSAGE, INTERRUPTED_PARTIAL_MESSAGE } from "../queue";
import { INTERRUPTED_ERROR, INTERRUPTED_PARTIAL_ERROR } from "@/lib/errors/friendly";

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
});

describe("reconciler interruption copy", () => {
  it("says exactly what the runner says for the same state", () => {
    // Two hand-written sentences for one state drift, and they had: the reconciler
    // said "The task was interrupted before it finished", the runner "This task was
    // interrupted and didn't finish" — same event, different words depending on
    // which code path happened to win the race.
    expect(INTERRUPTED_MESSAGE).toBe(INTERRUPTED_ERROR.userMessage);
    expect(INTERRUPTED_PARTIAL_MESSAGE).toBe(INTERRUPTED_PARTIAL_ERROR.userMessage);
  });
});

describe("reconcileZombies", () => {
  it("writes the partial category, not one flat interrupted", async () => {
    await reconcileZombies();
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("interrupted_partial");
  });

  it("decides partial from the evidence the turn left in the row", async () => {
    // The SQL twin of producedWork: finished text, a tool result, or a tool that
    // ran and threw. Reasoning and an unanswered tool call are not work.
    await reconcileZombies();
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("tool-result");
    expect(sql).toContain("tool-error");
    expect(sql).not.toContain("'reasoning'");
  });

  // `parts` is the weaker of the predicate's two sources: an emergency context trim
  // empties it and keeps the ledger, and this statement runs precisely when the
  // worker is gone and cannot supply the in-memory ledger the TypeScript twin uses.
  // Pinned here rather than only in queue.integration.test.ts because that file is
  // RUN_INTEGRATION-gated: without this line an ordinary `npm test` covers the
  // second source not at all. `message_effects` appears nowhere else in the
  // statement, so deleting the clause is the only way to make this fail.
  it("reads the durable ledger too, not only the parts a trim can erase", async () => {
    await reconcileZombies();
    expect(String(query.mock.calls[0][0])).toContain("message_effects");
  });

  it("hands each reaped task its own verdict, so the live tab is told what the row says", async () => {
    query.mockResolvedValue({
      rows: [
        { id: "t1", user_id: "u1", chat_id: "c1", partial: true },
        { id: "t2", user_id: "u1", chat_id: "c2", partial: false },
      ],
    });
    expect(await reconcileZombies()).toEqual([
      { id: "t1", user_id: "u1", chat_id: "c1", partial: true },
      { id: "t2", user_id: "u1", chat_id: "c2", partial: false },
    ]);
  });
});

/**
 * The runner has no test file of its own, which is a known hole — so this pins the
 * WIRING by source, the way step-control.test.ts already pins runner.ts. It asserts
 * that a value reached a call site, NOT that the verdict is right; the verdict itself
 * is `producedWork`, covered in friendly.ts's own tests, and the end-to-end behaviour
 * is covered by queue.integration.test.ts on the reconciler side. Stated plainly so
 * the next reader knows exactly what this is worth.
 */
describe("the live failure verdict consults the ledger, not only the in-memory mirror", () => {
  const runner = readFileSync(new URL("../runner.ts", import.meta.url), "utf8");

  it("does not decide 'nothing ran' from turnEffects alone", () => {
    // A tool still RUNNING when the deadline fires never produces a result event, so
    // nothing was ever pushed into `turnEffects` — while a write-ahead row for it is
    // already on disk. Deciding from the mirror alone tells a user whose script was
    // half-way through writing files that the turn is a total loss.
    expect(runner).not.toMatch(/const hadEffects = turnEffects\.length > 0;/);
  });

  it("puts the tool set behind the write-ahead boundary before streaming", () => {
    // Without this the whole write-ahead half is dead code: rows would still only be
    // written when a result arrives, which is the gap it exists to close. Wrapped in
    // the runner rather than in run-context because msgId and taskId are what the row
    // is keyed by, and this is where both are already in scope.
    expect(runner).toMatch(/withEffectLedger\(/);
    // …and the raw, unwrapped set must not be what reaches streamText.
    expect(runner).not.toMatch(/^\s*tools: rawTools as never,/m);
  });

  it("carries an inherited ledger into the note without counting it as this turn's work", () => {
    // Why these are two arrays and not one. The note is CONTEXT — what the model must
    // not repeat. `turnEffects` is this reply's ACCOUNTING: it decides the failure
    // verdict and it is what gets written under this message's id. Folding the inherited
    // half into it would make a fresh turn report partial work before it had done
    // anything, and would attribute another reply's calls to this one.
    expect(runner).toMatch(/inheritedEffects/);
    expect(runner).toMatch(/buildRecoveryNote\(\[\.\.\.inheritedEffects, \.\.\.turnEffects\]\)/);
    expect(runner).not.toMatch(/turnEffects\.push\(\.\.\.inheritedEffects/);
    // The verdict is about THIS reply, so it must not read the inherited array either.
    expect(runner).not.toMatch(/hadEffects[^;]*inheritedEffects/);
  });

  it("states the inherited ledger to the FIRST stream, not only to a restart", () => {
    // The note used to be injected from discardPartial alone — i.e. only once something
    // had already restarted. A continuation's first stream is exactly where it is needed:
    // nothing restarted, and the previous reply's executed calls are invisible in the
    // transcript it was handed. `streamText` is called eagerly inside `makeStream`, so an
    // injection that happens after it cannot reach it — which makes this an ORDER
    // assertion, not a presence one.
    const firstCarry = runner.indexOf("carryEffectsIntoRestart();");
    const firstStream = runner.indexOf("= makeStream();");
    expect(firstCarry).toBeGreaterThan(-1);
    expect(firstStream).toBeGreaterThan(-1);
    expect(firstCarry).toBeLessThan(firstStream);
  });

  it("asks the ledger on both paths that form a failure verdict", () => {
    // The finalize path and the catch path. `loadEffects(resumeMessageId)` on the
    // approval-continuation path is a different call with a different argument, so
    // keying on `msgId` counts exactly the two verdict sites and nothing else.
    expect(runner.match(/loadEffects\(msgId\)/g) ?? []).toHaveLength(2);
  });
});
