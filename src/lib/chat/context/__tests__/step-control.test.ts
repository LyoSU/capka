import { describe, it, expect } from "vitest";
import { stepSettings, pruneTurnToolTraffic, armPruneBoundary, estimatePromptTokens,
  FORCE_TEXT_AFTER_STEPS, MAX_STEPS, WRAP_UP_AFTER_FRACTION } from "@/lib/chat/context/step-control";
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

  // The step budget and the wall-clock budget are separate ceilings, and a turn
  // doing heavy sandbox work hits the clock first — with tool time alone able to
  // exceed the deadline before the step cap is anywhere near. Without a clock-side
  // wrap-up the deadline lands mid-tool and the reply is a hard cut.
  it("leaves an early step alone however little of the clock has run", () => {
    expect(stepSettings(0, 0)).toEqual({});
    expect(stepSettings(0, WRAP_UP_AFTER_FRACTION / 2)).toEqual({});
  });

  it("forces a text answer once the turn has spent most of its wall-clock budget", () => {
    expect(stepSettings(0, WRAP_UP_AFTER_FRACTION)).toEqual({ toolChoice: "none" });
    expect(stepSettings(0, 1.5)).toEqual({ toolChoice: "none" });
  });

  it("defaults to no clock pressure, so a caller that passes only the step is unchanged", () => {
    expect(stepSettings(0)).toEqual({});
  });

  it("leaves room to answer after the wrap-up fires", () => {
    // A fraction of 1 would arm the brake exactly when the deadline aborts the
    // run — the wrap-up needs a slice of the budget left to write the answer in.
    expect(WRAP_UP_AFTER_FRACTION).toBeGreaterThan(0);
    expect(WRAP_UP_AFTER_FRACTION).toBeLessThan(1);
  });

  it("keeps the wrap-up step inside the hard cap, so it always gets a chance to fire", () => {
    // A too-high FORCE_TEXT_AFTER_STEPS would defer wrap-up past the ceiling and
    // hand back the very failure it exists to prevent.
    expect(FORCE_TEXT_AFTER_STEPS).toBeGreaterThanOrEqual(1);
    expect(FORCE_TEXT_AFTER_STEPS).toBeLessThanOrEqual(MAX_STEPS);
  });
});

/** One tool exchange, the shape a tool loop appends per step. */
const exchange = (id: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "upsert", input: { row: id.repeat(50) } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "upsert", output: { type: "json", value: { id } } }] },
];
const loop = (n: number): ModelMessage[] => [
  { role: "user", content: "add these rows" },
  ...Array.from({ length: n }, (_, i) => exchange(`t${i}`)).flat(),
];
const callCount = (ms: ModelMessage[]) => (JSON.stringify(ms).match(/"tool-call"/g) ?? []).length;

describe("pruneTurnToolTraffic", () => {
  it("sheds everything before the boundary and keeps the rest", () => {
    const msgs = loop(8);
    const out = pruneTurnToolTraffic(msgs, msgs.length - 3);

    expect(callCount(out)).toBeLessThan(callCount(msgs));
    // The newest exchange survives — the model still sees what it just did.
    expect(JSON.stringify(out)).toContain("t7");
    // The user's instruction is never tool traffic and must not be collateral.
    expect(out[0]).toEqual(msgs[0]);
  });

  it("does nothing while unarmed, so an ordinary turn is never rewritten", () => {
    const msgs = loop(8);
    expect(pruneTurnToolTraffic(msgs, 0)).toEqual(msgs);
  });

  it("keeps a FIXED cut byte-stable as the loop grows past it", () => {
    // This is the whole point of an absolute boundary. A `messages` value returned
    // from prepareStep is that step's prompt and nothing more — the SDK rebuilds
    // from its own initialMessages each step — so the cut has to be re-applied, and
    // re-applying a moving cut would re-shape the prefix (and re-bill the cache)
    // every step. Same boundary, two successive steps: the earlier step's output is
    // a prefix of the later one's.
    const boundary = loop(8).length - 3;
    const early = pruneTurnToolTraffic(loop(8), boundary);
    const later = pruneTurnToolTraffic([...loop(8), ...exchange("t8")], boundary);

    expect(later.slice(0, early.length)).toEqual(early);
    // …and the newly-arrived exchange is untouched, not swept up by the old cut.
    expect(JSON.stringify(later.slice(early.length))).toContain("t8");
  });

  it("never leaves a tool result whose call is gone", () => {
    // An orphaned tool_result is a hard 400 on Anthropic and OpenAI alike, so a
    // pruner that saved tokens by breaking pairs would trade a slow turn for a dead
    // one. Pairing is the SDK's job here; this pins that we rely on it.
    const msgs = loop(10);
    const out = pruneTurnToolTraffic(msgs, msgs.length - 3);

    const ids = (kind: "tool-call" | "tool-result") =>
      out
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
        .filter((c) => c.type === kind)
        .map((c) => c.toolCallId as string);
    const calls = new Set(ids("tool-call"));
    for (const id of ids("tool-result")) expect(calls.has(id)).toBe(true);
  });
});

describe("armPruneBoundary", () => {
  const at = 120_000;

  it("arms once the last step's measured prompt reaches the trigger", () => {
    expect(armPruneBoundary({ triggerAt: at, boundary: 0, lastStepContextTokens: at, messageCount: 20, stepNumber: 4 })).toBe(14);
    expect(armPruneBoundary({ triggerAt: at, boundary: 0, lastStepContextTokens: at - 1, messageCount: 20, stepNumber: 4 })).toBe(0);
  });

  it("stays out of the way of a provider that clears server-side", () => {
    // triggerAt 0 is how the runner says "Anthropic is handling this". Both firing
    // would clear the same history twice and pay two cache invalidations for it.
    expect(armPruneBoundary({ triggerAt: 0, boundary: 0, lastStepContextTokens: 900_000, messageCount: 400, stepNumber: 9 })).toBe(0);
  });

  it("holds the cut once armed, even though pruning drops the measurement back", () => {
    // The relief is what makes the next measurement small. A gate that re-decided
    // from the measurement alone would disarm here, restore the full history, and
    // re-shape the prompt — off and on, every other step.
    expect(armPruneBoundary({ triggerAt: at, boundary: 17, lastStepContextTokens: 40_000, messageCount: 40, stepNumber: 6 })).toBe(17);
  });

  it("only ever moves the cut forward, when genuinely new traffic crosses again", () => {
    expect(armPruneBoundary({ triggerAt: at, boundary: 17, lastStepContextTokens: at, messageCount: 60, stepNumber: 8 })).toBe(54);
    // A shorter list cannot drag the cut backwards and un-shed what was shed.
    expect(armPruneBoundary({ triggerAt: at, boundary: 57, lastStepContextTokens: at, messageCount: 20, stepNumber: 9 })).toBe(57);
  });

  it("does not arm on the first step of a turn", () => {
    // Nothing has finished yet, so there is no measurement — 0 must read as "wait".
    expect(armPruneBoundary({ triggerAt: at, boundary: 0, lastStepContextTokens: 0, messageCount: 3, stepNumber: 0 })).toBe(0);
  });

  it("will not arm off a measurement of a prompt that no longer exists", () => {
    // stepNumber restarts at 0 for every new stream, including the one the emergency
    // overflow retry makes — and the measurement it carries there is of the oversized
    // prompt that just 400'd. Arming off it would cut the deliberately short rebuilt
    // history down to its tail before the model had run once.
    expect(
      armPruneBoundary({ triggerAt: at, boundary: 0, lastStepContextTokens: 980_000, messageCount: 22, stepNumber: 0 }),
    ).toBe(0);
  });

  it("leaves invalidating a boundary to the caller instead of zeroing it itself", () => {
    // The step-0 guard is about the MEASUREMENT being a ghost, not about the boundary
    // being stale — only the code that starts a stream knows the list was replaced,
    // and it resets there. Returning 0 from here would put that decision in two
    // places, one of which cannot see the list.
    expect(
      armPruneBoundary({ triggerAt: at, boundary: 17, lastStepContextTokens: 40_000, messageCount: 30, stepNumber: 0 }),
    ).toBe(17);
  });
});

describe("estimatePromptTokens", () => {
  // The brake reads per-step usage, and an endpoint that rejects `stream_options`
  // reports none for the rest of the connection — leaving the figure at 0, forever
  // under any positive trigger. A local estimate is what lets the brake arm at all
  // on exactly the providers that have no server-side edit either.
  it("counts text, reasoning, and tool traffic", () => {
    const n = estimatePromptTokens([
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: [
        { type: "text", text: "b".repeat(400) },
        { type: "reasoning", text: "c".repeat(400) },
        { type: "tool-call", toolCallId: "t1", toolName: "x", input: "d".repeat(400) },
      ] },
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "t1", toolName: "x", output: "e".repeat(400) },
      ] },
    ] as never);

    // 400 each: user text, assistant text, reasoning, the call's input, the result.
    // A string input counts raw, not JSON-quoted — outputChars short-circuits on it.
    expect(n).toBe(Math.ceil(2000 / 4));
  });

  // An image is ~1.5k tokens and ~200k characters of base64. Counting its length
  // would arm the brake off an artifact of the encoding — and attachments are not
  // what the brake can shed anyway, so undercounting them is the safe direction.
  it("ignores a file part's encoded bytes", () => {
    const n = estimatePromptTokens([
      { role: "user", content: [
        { type: "text", text: "c".repeat(40) },
        { type: "file", mediaType: "image/png", data: "Z".repeat(200_000) },
      ] },
    ] as never);

    expect(n).toBe(10);
  });
});
