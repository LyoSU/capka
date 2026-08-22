import { describe, it, expect } from "vitest";
import { timedOutError, interruptedError } from "@/lib/errors/friendly";

/**
 * A run that dies on the wall-clock deadline or a lost lease has usually already
 * written files and streamed text. Telling that user to "try again" means
 * REGENERATE — re-running every tool and rewriting what the turn already produced.
 * These selectors are the same two-way split the stall path already makes
 * (providerUnresponsiveError), applied to the two failures that were still
 * reporting total loss regardless of what survived.
 */
describe("timedOutError", () => {
  it("reports a plain timeout when the turn produced nothing to keep", () => {
    expect(timedOutError([]).category).toBe("timed_out");
  });

  it("reports a partial timeout once the turn has written text worth keeping", () => {
    expect(timedOutError([{ type: "text", text: "Here are the two crops:" }]).category)
      .toBe("timed_out_partial");
  });

  it("counts a finished tool step as work, since it left files in the workspace", () => {
    expect(timedOutError([{ type: "tool-result" }]).category).toBe("timed_out_partial");
  });

  it("does not count reasoning or whitespace as work the user can keep", () => {
    expect(timedOutError([{ type: "reasoning", text: "Let me plan…" }]).category).toBe("timed_out");
    expect(timedOutError([{ type: "text", text: "  \n " }]).category).toBe("timed_out");
  });

  it("tells the partial case to continue rather than to start over", () => {
    expect(timedOutError([]).userMessage).toMatch(/try again/i);
    expect(timedOutError([{ type: "text", text: "x" }]).userMessage).toMatch(/continue/i);
  });

  // A tool that threw still had its hands on the workspace — a script can write
  // three files and then fail on the fourth. The runner ledgers exactly that call
  // as the one a restarted turn most needs to know about, so a predicate that reads
  // the same parts and calls it "nothing happened" contradicts its own neighbour.
  it("counts a tool that ran and then threw, because it may have written first", () => {
    expect(timedOutError([{ type: "tool-error" }]).category).toBe("timed_out_partial");
  });

  // `discardPartial` clears `parts` when an attempt is thrown away but deliberately
  // KEEPS the executed-call ledger: those calls happened and stay happened. A
  // timeout right after such a restart therefore sees no parts at all, and without
  // this signal reports total loss over writes that are still standing.
  it("counts executed calls that outlived a discarded attempt's parts", () => {
    expect(timedOutError([], true).category).toBe("timed_out_partial");
    expect(interruptedError([], true).category).toBe("interrupted_partial");
  });

  it("keeps one adminDetail for the one cause, however the turn ended", () => {
    expect(timedOutError([{ type: "text", text: "x" }]).adminDetail)
      .toBe(timedOutError([]).adminDetail);
  });
});

describe("interruptedError", () => {
  it("reports a plain interruption when nothing survived the restart", () => {
    expect(interruptedError([]).category).toBe("interrupted");
  });

  it("reports a partial interruption when the snapshot kept real work", () => {
    expect(interruptedError([{ type: "tool-result" }]).category).toBe("interrupted_partial");
  });

  it("tells the partial case to continue rather than to start over", () => {
    expect(interruptedError([]).userMessage).toMatch(/try again/i);
    expect(interruptedError([{ type: "text", text: "x" }]).userMessage).toMatch(/continue/i);
  });
});

describe("a tool call the SDK rejected before running it", () => {
  // The SDK synthesizes a `tool-error` for an unparseable call or an unknown tool
  // WITHOUT invoking execute, and that part still gets recorded so the call is not
  // left orphaned. Counting it as work tells the user "what it finished above is
  // kept — ask it to continue" when nothing ran at all.
  it("is not work worth keeping", () => {
    const parts = [{ type: "tool-error", id: "c1", name: "x", error: "invalid arguments", invalid: true }];

    expect(timedOutError(parts).category).toBe("timed_out");
    expect(interruptedError(parts).category).toBe("interrupted");
  });

  it("still counts when the call actually ran and then threw", () => {
    const parts = [{ type: "tool-error", id: "c1", name: "x", error: "disk full" }];

    expect(timedOutError(parts).category).toBe("timed_out_partial");
    expect(interruptedError(parts).category).toBe("interrupted_partial");
  });
});
