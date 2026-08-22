import { describe, it, expect } from "vitest";
import { stepSettings, pruneTurnToolTraffic, FORCE_TEXT_AFTER_STEPS, MAX_STEPS } from "@/lib/chat/context/step-control";
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
});
