import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { lateSteerPlan } from "../runner";

// The steer endpoint answers the client `ok` the moment the text is appended to
// `tasks.steers`, but the runner only reads that column before a STEP — so a steer
// that lands during the last provider call of a turn is never folded in. What the
// turn owes it afterwards is the whole subject here.
describe("lateSteerPlan", () => {
  it("keeps the words and answers them when the turn ended cleanly", () => {
    expect(lateSteerPlan({ status: "completed", suspended: false })).toEqual({ persist: true, answer: true });
  });

  // The defect this pins: the fallback used to exist only for `completed`, so a
  // provider call that failed AFTER the steer landed dropped the text entirely —
  // it is not in `messages.metadata.steers` (only consumed steers are) and the task
  // row is terminal, so nothing else held it. The client had already been told "ok".
  it("keeps the words of a turn that FAILED, without answering them", () => {
    expect(lateSteerPlan({ status: "failed", suspended: false })).toEqual({ persist: true, answer: false });
  });

  // Same loss, different cause. Answering is still refused: the user pressed stop,
  // and a reply they did not ask for is the opposite of what that press meant.
  it("keeps the words of a turn the user STOPPED, without answering them", () => {
    expect(lateSteerPlan({ status: "cancelled", suspended: false })).toEqual({ persist: true, answer: false });
  });

  // A suspended turn is owed NEITHER: its unread steers are carried into the
  // approval/answer continuation (`carriedSteers`), so persisting here would say
  // the same words twice and queue a turn over the very question being asked.
  it("leaves a suspended turn's steers to the continuation that carries them", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(lateSteerPlan({ status, suspended: true })).toEqual({ persist: false, answer: false });
    }
  });
});

// Asserted on runner.ts's SOURCE for the same reason config-check.test.ts and
// step-control.test.ts already do it on this file: the behavioural version needs
// `runAgentTask` against a live database, and those suites are RUN_INTEGRATION-gated
// so they would not run in this job at all.
//
// NAMED WEAKNESS: this pins the ORDER and the PRESENCE of the two gates, not their
// outcome. A refactor that keeps both calls but stops acting on their verdict would
// still pass. The behavioural assertion belongs in the gated runner suite.
describe("the late-steer follow-up turn passes the same gates as a chat send", () => {
  const runner = readFileSync(new URL("../runner.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // The fallback block, isolated so a `take`/`reserveBudget` elsewhere in this very
  // large file cannot stand in for the ones that must be HERE.
  const fallback = runner.slice(runner.indexOf("const steerPlan = lateSteerPlan("));

  it("holds a follow-up behind the flood bucket and the budget reservation", () => {
    expect(fallback).not.toBe("");
    const flood = fallback.indexOf("take(`chat:${userId}`)");
    const reserve = fallback.indexOf("reserveBudget(");
    const enqueue = fallback.indexOf("enqueueTask(");
    expect(flood).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(-1);
    // Both gates precede the paid work, not the other way round.
    expect(flood).toBeLessThan(enqueue);
    expect(reserve).toBeLessThan(enqueue);
  });

  it("releases the hold it reserved when no live turn takes it", () => {
    // The chat route's own rule: a folded/raced turn (created=false) does not own
    // the hold, and neither does a throw between the reservation and the enqueue.
    const enqueue = fallback.indexOf("enqueueTask(");
    const release = fallback.indexOf("releaseHold(followUpTaskId)");
    expect(release).toBeGreaterThan(enqueue);
  });

  it("keeps the message write outside the answer decision", () => {
    // The write must be reached on every persisting status; only the enqueue is
    // allowed to be gated on `steerPlan.answer`. The row itself is written by
    // `persistUnreadSteers`, which the throwing path calls too.
    const persist = fallback.indexOf("persistUnreadSteers(");
    const answerGate = fallback.indexOf("steerPlan.answer");
    expect(persist).toBeGreaterThan(-1);
    expect(answerGate).toBeGreaterThan(persist);
  });
});
