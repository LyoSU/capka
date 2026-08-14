import { describe, it, expect } from "vitest";
import { providerUnresponsiveError } from "@/lib/errors/friendly";

// A stalled-out turn gets one of two messages, and the difference is what the
// user can actually keep. "Something is already done" must not be claimed on a
// turn that only thought about it — that would send them looking for files that
// were never written.
describe("providerUnresponsiveError", () => {
  it("nothing produced → the plain 'model stopped responding'", () => {
    expect(providerUnresponsiveError([]).category).toBe("provider_unresponsive");
  });

  it("reasoning alone is not work the user can keep", () => {
    const err = providerUnresponsiveError([{ type: "reasoning", text: "Let me plan the page…" }]);
    expect(err.category).toBe("provider_unresponsive");
  });

  it("a tool call that never returned is not work either", () => {
    const err = providerUnresponsiveError([{ type: "tool-call", id: "t1", name: "write_file" }] as never);
    expect(err.category).toBe("provider_unresponsive");
  });

  it("whitespace-only text is not work", () => {
    expect(providerUnresponsiveError([{ type: "text", text: "  \n " }]).category).toBe("provider_unresponsive");
  });

  it("answer text already on screen → the 'cut off part-way' message", () => {
    const err = providerUnresponsiveError([{ type: "text", text: "Here is the plan:" }]);
    expect(err.category).toBe("provider_unresponsive_partial");
  });

  it("a completed tool step → the 'cut off part-way' message", () => {
    const err = providerUnresponsiveError([
      { type: "tool-call", id: "t1", name: "write_file" },
      { type: "tool-result", id: "t1", name: "write_file", output: { ok: true } },
    ] as never);
    expect(err.category).toBe("provider_unresponsive_partial");
  });

  it("both messages carry the same admin detail — one cause, two audiences", () => {
    const nothing = providerUnresponsiveError([]);
    const partial = providerUnresponsiveError([{ type: "text", text: "x" }]);
    expect(partial.adminDetail).toBe(nothing.adminDetail);
  });
});
