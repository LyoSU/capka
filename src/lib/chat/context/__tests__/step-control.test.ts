import { describe, it, expect } from "vitest";
import { stepSettings, pruneTurnToolTraffic, armPruneBoundary, estimatePromptTokens, injectSteers,
  FORCE_TEXT_AFTER_STEPS, MAX_STEPS, WRAP_UP_AFTER_FRACTION, BYTES_PER_TOKEN } from "@/lib/chat/context/step-control";
import type { ModelMessage } from "ai";
import { readFileSync } from "node:fs";

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

  it("re-arms at step 0 of a re-stream, instead of giving a restart one unbraked step", () => {
    // Every re-stream resets the boundary, because it indexes a list the SDK threw
    // away. Refusing to arm at step 0 then meant a turn that had ALREADY crossed the
    // trigger came back with no cut and had to wait for step 1 to re-earn it — and
    // that step is the first request after an overflow, which is the one least able
    // to afford carrying the traffic again.
    expect(armPruneBoundary({
      triggerAt: at, boundary: 0, lastStepContextTokens: 0, estimatedTokens: at,
      messageCount: 40, stepNumber: 0, armedEarlier: true,
    })).toBe(34);
  });

  it("will not arm at step 0 on a turn that never needed the brake", () => {
    // The pair that makes the line above safe. A first stream has accumulated no tool
    // traffic of its own, so an estimate over the trigger describes the CHAT's history
    // — upstream compaction's business. Arming here would shed a long conversation's
    // tool results before the model had run once, and the estimate over-counts prose,
    // so it would happen well under the real trigger.
    expect(armPruneBoundary({
      triggerAt: at, boundary: 0, lastStepContextTokens: 0, estimatedTokens: at * 2,
      messageCount: 40, stepNumber: 0, armedEarlier: false,
    })).toBe(0);
  });

  it("still refuses the stale report at step 0, even having armed before", () => {
    // `armedEarlier` widens WHICH figure may arm the cut, not whether a ghost counts as
    // one. The overflow retry's stepNumber-0 report is of the oversized prompt that
    // just 400'd; a fresh local count of the rebuilt list is the only honest number
    // there, and here it says the list is small.
    expect(armPruneBoundary({
      triggerAt: at, boundary: 0, lastStepContextTokens: 980_000, estimatedTokens: 1_000,
      messageCount: 22, stepNumber: 0, armedEarlier: true,
    })).toBe(0);
  });

  it("does not shed a rebuilt history shorter than what the policy keeps", () => {
    // `buildResumeMessages` returns exactly 3 messages for a tool loop of any length —
    // StoredPart carries no `step-start`, so convertToModelMessages collapses the whole
    // loop into one assistant + one tool message. Those 3 still carry the loop's TOKENS,
    // so the estimate is legitimately over the trigger and step-0 arming IS reached here.
    //
    // Asserted THROUGH the pruner, and in a pair, because two weaker versions of this
    // test passed while the thing they named was broken. `toBe(0)` on the returned index
    // could not fail: the index is floored by `boundary`. Pruning the short list alone
    // could not fail either — and THAT is the finding worth keeping. A 3-message rebuilt
    // list holds all its tool traffic in the last PAIR, and the SDK's pruner drops calls
    // and results as pairs, so no boundary can over-shed it. The short case is safe
    // structurally, not because the arithmetic guards it.
    //
    // So the pair is the guard: same boundary, a list long enough to have a droppable
    // pair, and that one must lose it. If the pruner ever stops shedding, this fails.
    const cycle = (n: string): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: n, toolName: "x", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: n, toolName: "x", output: "ok" }] },
    ] as ModelMessage[];
    const arm = (messageCount: number) => armPruneBoundary({
      triggerAt: at, boundary: 0, lastStepContextTokens: 0, estimatedTokens: at * 4,
      messageCount, stepNumber: 0, armedEarlier: true,
    });

    const rebuilt = [{ role: "user", content: "go" } as ModelMessage, ...cycle("t1")];
    expect(pruneTurnToolTraffic(rebuilt, arm(rebuilt.length))).toEqual(rebuilt);

    const long = [{ role: "user", content: "go" } as ModelMessage,
      ...cycle("t1"), ...cycle("t2"), ...cycle("t3"), ...cycle("t4"), ...cycle("t5")];
    expect(pruneTurnToolTraffic(long, arm(long.length))).not.toEqual(long);
  });

  it("prefers the provider's figure over the estimate once a step has finished", () => {
    // From step 1 on the report is a measurement of a prompt that really was sent, and
    // the estimate is a guess about the next one. Taking the larger of the two would let
    // the guess arm the brake on a provider that reports a smaller real number — which
    // is most providers, and the estimate over-counts prose.
    expect(armPruneBoundary({
      triggerAt: at, boundary: 0, lastStepContextTokens: at - 1, estimatedTokens: at * 3,
      messageCount: 40, stepNumber: 3,
    })).toBe(0);
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
    expect(n).toBe(Math.ceil(2000 / BYTES_PER_TOKEN));
  });

  it("does not undercount a two-byte script, where a per-character ratio would", () => {
    // The defect this replaced: four characters per token is an ENGLISH ratio, and
    // a script outside Latin-1 runs closer to two bytes a character. On a character
    // count a real 120k-token Ukrainian conversation measured 60k and never crossed
    // the trigger, so the brake was absent for precisely the locale this product
    // calls first-class. Greek stands in for it here — same two bytes, same maths.
    const twoByte = "υπολογισμό".repeat(40); // 400 characters, 800 UTF-8 bytes
    const latin = "a".repeat(400);

    const wide = estimatePromptTokens([{ role: "user", content: twoByte }] as never);
    const narrow = estimatePromptTokens([{ role: "user", content: latin }] as never);
    expect(wide).toBe(Math.ceil(800 / BYTES_PER_TOKEN));
    expect(narrow).toBe(Math.ceil(400 / BYTES_PER_TOKEN));
    // Same character count, twice the estimate — that gap IS the bug, now visible.
    // A ratio, not `en * 2`: that form only holds for a divisor that divides both byte
    // counts evenly, so it pinned an arithmetic accident of the constant rather than
    // the property, and failed the moment the constant changed.
    expect(wide / narrow).toBeGreaterThan(1.9);
  });

  it("counts a two-byte script inside tool arguments too, not only in prose", () => {
    // Where it actually bites: the turn that started all this wrote product rows
    // whose names are Ukrainian, so the mass was in tool-call arguments.
    const n = estimatePromptTokens([
      { role: "assistant", content: [
        { type: "tool-call", toolCallId: "t1", toolName: "upsert", input: { name: "Κουβάς" } },
      ] },
    ] as never);
    // {"name":"Κουβάς"} — 17 characters, 23 bytes once the six wide ones double.
    expect(n).toBe(Math.ceil(23 / BYTES_PER_TOKEN));
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

    // The 40-byte text and nothing else. Asserted as a bound on the whole estimate,
    // not just as "not 200k": a term for the file part at ANY ratio would break this.
    expect(n).toBe(Math.ceil(40 / BYTES_PER_TOKEN));
  });

  it("keeps the divisor below what dense JSON actually costs", () => {
    // The guard on the constant, and it is on the PROPERTY rather than the value: any
    // divisor that leaves the estimate at or above dense JSON's real token cost is
    // correct here, and 4 — the value this replaced — is not one of them.
    //
    // Measured on o200k over content from this repo: English prose 4.2-4.4 bytes per
    // token, Ukrainian prose 4.8-5.1, TypeScript 4.2, tool-call arguments 3.4-3.8, and
    // a serialized package.json as a tool result 2.58. Prose was never the problem;
    // `/4` under-counted the JSON that is nearly all of what this function weighs, by
    // up to 35%, and under-counting is the direction that costs a whole turn.
    expect(BYTES_PER_TOKEN).toBeLessThan(3.8);
    // And not a blanket safety factor either: over-counting prose by more than ~2x
    // would arm the brake on turns with room to spare, which is the trade `8cd630e`
    // rejected when it turned down a flat /2.
    expect(BYTES_PER_TOKEN).toBeGreaterThan(2.4);
  });
});

describe("the estimate's boundary", () => {
  // `estimatePromptTokens` may arm the brake and must never become the number the
  // (i) popover and the context meter report — an estimate rendered to an admin as a
  // measurement is a different defect from the one it fixes. What keeps those apart
  // is a single character: the runner passes it as an ARGUMENT
  // (`lastStepContextTokens || estimatePromptTokens(base)`), and `||=` there would
  // feed contextBudget and three `contextTokens` writes at once. A boundary that
  // survives only because nobody typed one extra character is not a boundary, so it
  // is asserted here rather than described in a comment.
  const runner = readFileSync(new URL("../../../tasks/runner.ts", import.meta.url), "utf8");

  it("never lets the estimate become the measured figure", () => {
    const writes = [...runner.matchAll(/lastStepContextTokens\s*(\|\|=|\?\?=|\+=|=(?!=))/g)].map((m) => m[1]);
    // Exactly two plain assignments: the declaration, and the write from usage.
    // Any compound form shows up here as itself and fails with a readable diff.
    expect(writes).toEqual(["=", "="]);
    expect(runner).toMatch(/lastStepContextTokens = event\.usage\.inputTokens/);
  });
});

describe("injectSteers", () => {
  const say = (text: string): ModelMessage => ({ role: "assistant", content: text });
  const tool = (): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "t", output: { type: "text", value: "ok" } }] });
  const textOf = (m: ModelMessage) => (typeof m.content === "string" ? m.content : "");

  it("appends a fresh steer at the tail, where every provider accepts a user message", () => {
    const step = [say("a"), tool()];
    const { messages, steers } = injectSteers(step, [{ id: "s1", text: "also chart it" }]);
    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("user");
    expect(textOf(messages[2])).toContain("also chart it");
    // Framed, so the model can tell it from the request the turn started on.
    expect(textOf(messages[2])).not.toBe("also chart it");
    expect(steers[0].index).toBe(2);
  });

  // The whole point of recording the index: the SDK rebuilds the list from its own
  // history each step, so re-appending would move the steer past the assistant
  // message that answered it and change the prefix on every step.
  it("holds a steer at the same absolute index while the turn keeps growing", () => {
    const step1 = [say("a"), tool()];
    const a = injectSteers(step1, [{ id: "s1", text: "also chart it" }]);
    expect(a.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);

    // Step 2: the SDK has appended the reply to the steer plus another tool result.
    const step2 = [say("a"), tool(), say("b"), tool()];
    const b = injectSteers(step2, a.steers);
    expect(b.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant", "tool"]);
    expect(textOf(b.messages[2])).toContain("also chart it");
    expect(b.steers[0].index).toBe(2);

    // Step 3: still index 2, still the same prefix.
    const step3 = [...step2, say("c"), tool()];
    const c = injectSteers(step3, b.steers);
    expect(c.messages.slice(0, 3).map(textOf)).toEqual(b.messages.slice(0, 3).map(textOf));
    expect(c.steers[0].index).toBe(2);
  });

  it("shifts a later steer past the earlier ones instead of overwriting their slot", () => {
    const step1 = [say("a"), tool()];
    const a = injectSteers(step1, [{ id: "s1", text: "first" }]);

    // A second steer arrives two messages later — it anchors to the END of the
    // UN-injected list, so the two indices stay comparable to each other.
    const step2 = [say("a"), tool(), say("b"), tool()];
    const b = injectSteers(step2, [...a.steers, { id: "s2", text: "second" }]);
    expect(b.steers.map((s) => s.index)).toEqual([2, 4]);
    expect(b.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant", "tool", "user"]);
    expect(textOf(b.messages[2])).toContain("first");
    expect(textOf(b.messages[5])).toContain("second");

    // And on the next step both are put back where they were — the earlier one
    // pushing the later one one slot along, which is the arithmetic that would
    // silently drop a steer if the walk spliced repeatedly instead.
    const step3 = [...step2, say("c"), tool()];
    const c = injectSteers(step3, b.steers);
    expect(c.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant", "tool", "user", "assistant", "tool"]);
    expect(textOf(c.messages[2])).toContain("first");
    expect(textOf(c.messages[5])).toContain("second");
  });

  it("is a no-op with nothing to inject, so an unsteered turn's prompt is untouched", () => {
    const step = [say("a"), tool()];
    const { messages, steers } = injectSteers(step, []);
    expect(messages).toBe(step);
    expect(steers).toEqual([]);
  });

  it("re-anchors to the new tail after a re-stream drops the indices", () => {
    // makeStream strips `index` because it points into a list the SDK threw away.
    const rebuilt = [say("resumed"), tool(), say("x")];
    const { messages, steers } = injectSteers(rebuilt, [{ id: "s1", text: "first" }]);
    expect(steers[0].index).toBe(3);
    expect(messages[3].role).toBe("user");
  });
});

describe("a steered turn that also has to prune", () => {
  // The two mechanisms meet in `prepareStep` and count in different units. The
  // prune boundary is an index into the UN-injected list, while the pruner counts
  // TRAILING messages of the list it is actually handed — so every steer sitting in
  // the pruned prefix pushes the protected window one message earlier and buys back
  // an exchange of tool traffic the turn had decided to shed. The runner corrects
  // for exactly that (`pruneBoundary + before`); this pins that the correction is
  // right, and that removing it is observable.
  const ids = (ms: ModelMessage[]) =>
    ms
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
      .filter((c) => c.type === "tool-call")
      .map((c) => c.toolCallId as string);
  const at = (ms: ModelMessage[], needle: string) =>
    ms.findIndex((m) => typeof m.content === "string" && m.content.includes(needle));

  // One steer landed while the turn was four exchanges in, the second only once it
  // had run all eight — so a cut taken between them has one steer either side.
  const base = loop(8);
  const early = injectSteers(loop(4), [{ id: "s1", text: "keep it short" }]);
  const steered = injectSteers(base, [...early.steers, { id: "s2", text: "and cite it" }]);
  const before = (b: number) => steered.steers.filter((s) => (s.index ?? 0) <= b).length;
  const boundary = base.length - 4;

  it("sits the two steers either side of the cut, which is what makes this a test", () => {
    expect(steered.steers.map((s) => s.index)).toEqual([9, base.length]);
    expect(before(boundary)).toBe(1);
  });

  it("sheds exactly the tool traffic the unsteered turn would have, at every cut", () => {
    // The invariant, not one lucky boundary: whatever the turn decides to shed, a
    // steered turn sheds the same exchanges. Some cuts land mid-pair and are
    // unaffected either way, which is why a single case can pass while the
    // correction is missing.
    for (let b = 1; b < base.length; b++) {
      expect(ids(pruneTurnToolTraffic(steered.messages, b + before(b)))).toEqual(ids(pruneTurnToolTraffic(base, b)));
    }
  });

  it("would buy back an exchange without the correction, which is the bug", () => {
    const plain = ids(pruneTurnToolTraffic(base, boundary));
    const uncorrected = ids(pruneTurnToolTraffic(steered.messages, boundary));
    expect(uncorrected).not.toEqual(plain);
    expect(uncorrected.length).toBeGreaterThan(plain.length);
  });

  it("keeps the early steer in the pruned prefix and the late one in the protected tail", () => {
    const out = pruneTurnToolTraffic(steered.messages, boundary + before(boundary));
    // Neither is collateral: a steer is a user message, never tool traffic.
    expect(at(out, "keep it short")).toBeGreaterThanOrEqual(0);
    expect(at(out, "and cite it")).toBe(out.length - 1);
    // The early one is ahead of every tool call that survived — i.e. it is in the
    // part of the prompt that was shed, exactly where it landed.
    const firstSurviving = out.findIndex((m) =>
      Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((c) => c.type === "tool-call"));
    expect(at(out, "keep it short")).toBeLessThan(firstSurviving);
  });
});
