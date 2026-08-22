import { describe, it, expect } from "vitest";
import { stepSettings, pruneTurnToolTraffic, shouldPruneTurnMidFlight,
  FORCE_TEXT_AFTER_STEPS, MAX_STEPS } from "@/lib/chat/context/step-control";
import type { ModelMessage } from "ai";

describe("stepSettings", () => {
  it("does not override anything for normal early steps", () => {
    expect(stepSettings(0)).toEqual({});
    expect(stepSettings(FORCE_TEXT_AFTER_STEPS - 1)).toEqual({});
  });

  it("forces a text answer once a tool loop runs long, so it can't spin to the hard step cap", () => {
    expect(stepSettings(FORCE_TEXT_AFTER_STEPS)).toEqual({ toolChoice: "none" });
    expect(stepSettings(FORCE_TEXT_AFTER_STEPS + 3)).toEqual({ toolChoice: "none" });
  });

  it("keeps the wrap-up step inside the hard cap, so it always gets a chance to fire", () => {
    // A too-high FORCE_TEXT_AFTER_STEPS would defer wrap-up past the ceiling and
    // hand back the very failure it exists to prevent.
    expect(FORCE_TEXT_AFTER_STEPS).toBeGreaterThanOrEqual(1);
    expect(FORCE_TEXT_AFTER_STEPS).toBeLessThanOrEqual(MAX_STEPS);
  });
});

describe("pruneTurnToolTraffic", () => {
  /** One tool exchange, the shape a tool loop appends per step. */
  const exchange = (id: string): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "upsert", input: { row: id.repeat(50) } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "upsert", output: { type: "json", value: { id } } }] },
  ];

  it("sheds the older exchanges of a long loop and keeps the freshest ones", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "add these rows" },
      ...Array.from({ length: 8 }, (_, i) => exchange(`t${i}`)).flat(),
    ];

    const out = pruneTurnToolTraffic(msgs);

    const calls = (ms: ModelMessage[]) => (JSON.stringify(ms).match(/"tool-call"/g) ?? []).length;
    expect(calls(out)).toBeLessThan(calls(msgs));
    // The newest exchange survives — the model still sees what it just did.
    expect(JSON.stringify(out)).toContain("t7");
    // The user's instruction is never tool traffic and must not be collateral.
    expect(out[0]).toEqual(msgs[0]);
  });

  it("leaves a short loop alone, so an ordinary turn is never rewritten", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }, ...exchange("t0")];
    expect(pruneTurnToolTraffic(msgs)).toEqual(msgs);
  });

  it("never leaves a tool result whose call is gone", () => {
    // An orphaned tool_result is a hard 400 on Anthropic and OpenAI alike, so a
    // pruner that saved tokens by breaking pairs would trade a slow turn for a dead
    // one. Pairing is the SDK's job here; this pins that we rely on it.
    const msgs: ModelMessage[] = [
      { role: "user", content: "add these rows" },
      ...Array.from({ length: 10 }, (_, i) => exchange(`t${i}`)).flat(),
    ];

    const out = pruneTurnToolTraffic(msgs);

    const ids = (kind: "tool-call" | "tool-result") =>
      out
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
        .filter((c) => c.type === kind)
        .map((c) => c.toolCallId as string);
    const calls = new Set(ids("tool-call"));
    for (const id of ids("tool-result")) expect(calls.has(id)).toBe(true);
  });
});

describe("shouldPruneTurnMidFlight", () => {
  const at = 120_000;

  it("fires once the last step's measured prompt reaches the trigger", () => {
    expect(shouldPruneTurnMidFlight({ triggerAt: at, alreadyPruned: false, lastStepContextTokens: at })).toBe(true);
    expect(shouldPruneTurnMidFlight({ triggerAt: at, alreadyPruned: false, lastStepContextTokens: at - 1 })).toBe(false);
  });

  it("stays out of the way of a provider that clears server-side", () => {
    // triggerAt 0 is how the runner says "Anthropic is handling this". Both firing
    // would clear the same history twice and pay two cache invalidations for it.
    expect(shouldPruneTurnMidFlight({ triggerAt: 0, alreadyPruned: false, lastStepContextTokens: 900_000 })).toBe(false);
  });

  it("is a latch, not a re-measurement", () => {
    // A successful prune drops the next step's prompt back under the trigger. If the
    // decision re-measured instead of latching, the turn would oscillate: prune,
    // refill, prune — a fresh cache write every time round.
    expect(shouldPruneTurnMidFlight({ triggerAt: at, alreadyPruned: true, lastStepContextTokens: 900_000 })).toBe(false);
  });

  it("does not fire on the first step of an ordinary turn", () => {
    // Nothing has finished yet, so there is no measurement — 0 must read as "wait".
    expect(shouldPruneTurnMidFlight({ triggerAt: at, alreadyPruned: false, lastStepContextTokens: 0 })).toBe(false);
  });
});
