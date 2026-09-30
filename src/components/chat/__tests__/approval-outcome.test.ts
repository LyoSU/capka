import { describe, it, expect } from "vitest";
import { toUIMessages } from "@/lib/chat/presenter";
import type { StoredPart } from "@/lib/chat/contracts";
import { isApprovalPart } from "../message";
import { readDecisionReply } from "../manage-cards";

/**
 * An approval whose turn can no longer run (its model connection was removed) is
 * settled on the spot: an approved call gets a `NOT_RUN` result, the turn fails.
 * For a gated connector/skill call that result used to take the part out of its
 * card and into the activity rail, where a call that never ran showed the "done"
 * glyph under an English "Not run." line.
 */
describe("isApprovalPart — a gated call that was approved but never ran", () => {
  const settled = (name: string) => {
    const parts: StoredPart[] = [
      { type: "tool-call", id: "c1", name, input: { to: "a@b.c" }, approval: { id: "a1", approved: true } },
      { type: "tool-result", id: "c1", name, output: { status: "error", code: "NOT_RUN", error: "Not run. The model isn't available right now." } },
    ] as StoredPart[];
    const [reply] = toUIMessages([{ id: "m1", role: "assistant", content: "", metadata: { parts }, createdAt: null, platform: null }]);
    return reply.parts[0] as Parameters<typeof isApprovalPart>[0];
  };

  it("keeps its card, which says it did not run, instead of a finished step in the rail", () => {
    expect(isApprovalPart(settled("mcp__gmail__send"))).toBe(true);
  });

  it("still returns a gated call that ran to the rail — with its result, or as a failed step", () => {
    const ran = { ...settled("mcp__gmail__send"), output: { id: "msg-1" } };
    expect(isApprovalPart(ran)).toBe(false);
    // An approved call that threw: a real step, whose error the rail shows in full.
    const threw = { ...ran, state: "output-error", output: undefined, errorText: "SMTP refused" };
    expect(isApprovalPart(threw)).toBe(false);
  });

  it("keeps a manage call in its card whatever its outcome", () => {
    expect(isApprovalPart(settled("manage"))).toBe(true);
  });
});

/**
 * The approve/answer endpoints answer 200 with an `outcome`; the cards used to read
 * only `ok`, so "busy" silently re-enabled the buttons and a decision that was kept
 * but whose turn could not continue gave no sign of it.
 */
describe("readDecisionReply", () => {
  it("a decision that landed: success, buttons stay down", () => {
    expect(readDecisionReply(200, { ok: true, outcome: "applied" })).toEqual({ landed: true, retry: false, note: null });
  });

  it("busy: says so, and the buttons come back", () => {
    expect(readDecisionReply(200, { ok: false, outcome: "busy" })).toEqual({ landed: false, retry: true, note: "busy" });
  });

  it("kept but its turn could not continue: says so, no success, no second tap", () => {
    expect(readDecisionReply(200, { ok: false, outcome: "failed" })).toEqual({ landed: false, retry: false, note: "stopped" });
  });

  it("the spending limit and the flood guard are told apart by code", () => {
    expect(readDecisionReply(429, { code: "BUDGET_EXCEEDED" }).note).toBe("budgetReached");
    expect(readDecisionReply(429, { code: "RATE_LIMITED" }).note).toBe("rateLimited");
    expect(readDecisionReply(429, { code: "RATE_LIMITED" }).retry).toBe(true);
  });

  it("gone, an outcome this build does not know, or a server error is never success", () => {
    for (const [status, body] of [[200, { ok: false, outcome: "gone" }], [200, { ok: false, outcome: "later-outcome" }], [500, { ok: true }]] as const) {
      expect(readDecisionReply(status, body)).toEqual({ landed: false, retry: true, note: null });
    }
  });
});
