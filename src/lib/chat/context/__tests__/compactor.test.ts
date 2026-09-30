import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { buildCompactionMessages, compactConversation, compactionInput, compactionReply, COMPACTION_INSTRUCTION } from "@/lib/chat/context/compactor";
import { buildResumeMessages } from "@/lib/tasks/resume";
import { armPruneBoundary, estimatePromptTokens, pruneTurnToolTraffic } from "@/lib/chat/context/step-control";
import { contextManagementOptions, toolClearTrigger } from "@/lib/chat/context/provider-edits";
import { DEFAULT_CONTEXT_LENGTH, COMPACT_THRESHOLD } from "@/lib/chat/context/budget";
import { CLEARED_TOOL_OUTPUT } from "@/lib/chat/context/tool-clearing";
import type { StoredPart } from "@/lib/chat/contracts";
import type { ModelMessage } from "ai";

describe("buildCompactionMessages", () => {
  const system: ModelMessage[] = [{ role: "system", content: "persona" }];
  const history: ModelMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];

  it("appends the compaction instruction as the final user turn, keeping the prefix intact", () => {
    const out = buildCompactionMessages(system, history);

    // Cache-friendly: the existing system + history prefix is preserved byte-for-byte
    // and in order, so the hot prompt-cache prefix from the just-finished turn hits.
    expect(out.slice(0, -1)).toEqual([...system, ...history]);

    // The instruction rides as the LAST message, as a user turn.
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(COMPACTION_INSTRUCTION);
  });
});

describe("compactionReply", () => {
  // Every tool-call / tool-result part in the list, by id — the pairing the provider
  // checks. A repeated call id or a call without its result is a hard 400.
  const toolParts = (msgs: ModelMessage[], type: "tool-call" | "tool-result") =>
    msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; toolCallId?: string }[]) : []))
      .filter((p) => p.type === type)
      .map((p) => p.toolCallId);

  it("sheds the tool bodies the live turn already pruned, so the request fits the window", async () => {
    // A file-reading loop: ten reads of ~20k tokens each. The live turn pruned the
    // older ones mid-loop and compaction fired on that pruned size; replayed in full
    // they come to more than the whole window.
    const body = "x".repeat(60_000);
    const parts: StoredPart[] = [];
    for (let i = 0; i < 10; i++) {
      parts.push({ type: "tool-call", id: `r${i}`, name: "read_file", input: { path: `f${i}.csv` } });
      parts.push({ type: "tool-result", id: `r${i}`, name: "read_file", output: body });
    }
    parts.push({ type: "text", text: "The totals match." });
    // Control: the full replay really is over the window.
    expect(estimatePromptTokens(await buildResumeMessages("m", parts))).toBeGreaterThan(DEFAULT_CONTEXT_LENGTH);

    const reply = await compactionReply("m", parts, [], false);
    expect(estimatePromptTokens(reply)).toBeLessThan(DEFAULT_CONTEXT_LENGTH * COMPACT_THRESHOLD);
    const text = JSON.stringify(reply);
    // The newest three keep their bodies, the rest are placeholders, the answer stays.
    expect(text.split(body).length - 1).toBe(3);
    expect(text.split(CLEARED_TOOL_OUTPUT).length - 1).toBe(7);
    expect(text).toContain("The totals match.");
    // Every call still has exactly one result.
    expect(toolParts(reply, "tool-call")).toEqual(toolParts(reply, "tool-result"));
  });

  it("carries an approval/ask continuation as one call and one result per id", async () => {
    // The first half suspended on an approval and an ask; the continuation appended
    // their results and the answer — all in the same row's `parts`.
    const parts: StoredPart[] = [
      { type: "text", text: "I will save it." },
      { type: "tool-call", id: "c1", name: "write_file", input: { path: "a.txt" }, approval: { id: "ap1", approved: true } },
      { type: "tool-call", id: "c2", name: "ask", input: {}, answer: { form: { fields: [{ id: "q", kind: "text", label: "Quarter" }] }, value: { action: "submit", values: { q: "Q3" } } } },
      { type: "tool-result", id: "c1", name: "write_file", output: "ok" },
      { type: "tool-result", id: "c2", name: "ask", output: { q: "Q3" } },
      { type: "text", text: "Saved for Q3." },
    ];
    const reply = await compactionReply("m", parts, [], false);
    const calls = toolParts(reply, "tool-call");
    expect(calls.sort()).toEqual(["c1", "c2"]);
    expect(toolParts(reply, "tool-result").sort()).toEqual(calls);
    expect(JSON.stringify(reply)).toContain("Saved for Q3.");
  });

  it("keeps the reasoning and the steers the next turn would see", async () => {
    const parts: StoredPart[] = [
      { type: "reasoning", text: "The user wants metric." },
      { type: "text", text: "Converted to kilograms." },
    ];
    const steers = [{ id: "s1", text: "use metric units", at: "2026-09-30T00:00:00Z", atStep: 0, afterToolCallId: null }];
    const reply = await compactionReply("m", parts, steers, false);
    // The steer comes first, as the user's words, the way expandSteers replays it.
    expect(reply[0].role).toBe("user");
    expect(JSON.stringify(reply[0].content)).toContain("use metric units");
    const answer = reply.at(-1)!;
    expect(answer.role).toBe("assistant");
    expect(JSON.stringify(answer.content)).toContain('"type":"reasoning"');

    // A backend that rejects the reasoning echo gets it folded into the text instead.
    const folded = (await compactionReply("m", parts, [], true)).at(-1)!;
    expect(JSON.stringify(folded.content)).not.toContain('"type":"reasoning"');
    expect(JSON.stringify(folded.content)).toContain("The user wants metric.");
  });
});

describe("compactionInput", () => {
  const reads = (prefix: string, n: number, body: string): StoredPart[] => [
    ...Array.from({ length: n }, (_, i): StoredPart[] => [
      { type: "tool-call", id: `${prefix}${i}`, name: "read_file", input: { path: `${prefix}${i}.csv` } },
      { type: "tool-result", id: `${prefix}${i}`, name: "read_file", output: body },
    ]).flat(),
    { type: "text", text: "Done." },
  ];

  it("sheds the history the mid-turn prune shed, so the request fits the window it was measured against", async () => {
    // A 32k local model. The previous turn read two files and ended just under the
    // clear trigger, so this turn's history was built with every body intact; this
    // turn then read four more, the prune armed and cut into that history too.
    const window = 32_768;
    const old = "o".repeat(20_000);
    const fresh = "n".repeat(22_000);
    const system: ModelMessage[] = [{ role: "system", content: "s".repeat(9_000) }];
    const history: ModelMessage[] = [
      { role: "user", content: "read p0 and p1" },
      ...(await buildResumeMessages("p", reads("p", 2, old))).slice(0, -1),
      { role: "user", content: "now read c0..c3" },
    ];
    // Control: the history really was under the trigger, so nothing cleared it at
    // turn start, and the live prompt the budget measured is the PRUNED one.
    expect(estimatePromptTokens([...system, ...history])).toBeLessThan(toolClearTrigger(window));
    const turn: ModelMessage[] = Array.from({ length: 4 }, (_, i): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: { path: `c${i}.csv` } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_file", output: { type: "text", value: fresh } }] },
    ]).flat();
    const live = [...system, ...history, ...turn];
    const cut = armPruneBoundary({
      triggerAt: toolClearTrigger(window), boundary: 0, lastStepContextTokens: estimatePromptTokens(live),
      messageCount: live.length, stepNumber: 4,
    });
    expect(estimatePromptTokens(pruneTurnToolTraffic(live, cut))).toBeGreaterThanOrEqual(window * COMPACT_THRESHOLD);

    const reply = await compactionReply("m", reads("c", 4, fresh), [], false);
    // The finding: history + reply replays the bodies the prune shed, past the window.
    expect(estimatePromptTokens([...system, ...compactionInput(history, reply, false)])).toBeGreaterThan(window);
    const input = compactionInput(history, reply, true);
    expect(estimatePromptTokens([...system, ...input])).toBeLessThan(window);
    const text = JSON.stringify(input);
    expect(text).not.toContain(old);
    expect(text.split(fresh).length - 1).toBe(3);
    expect(text).toContain("Done.");
  });

  it("leaves the list alone when the prune never armed", async () => {
    const history: ModelMessage[] = [{ role: "user", content: "q" }];
    const reply = await compactionReply("m", reads("c", 4, "body"), [], false);
    expect(compactionInput(history, reply, false)).toEqual([...history, ...reply]);
  });
});

describe("compactConversation", () => {
  const generated = (text: string) => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 2 } },
    warnings: [],
  }) as never;
  const history: ModelMessage[] = [
    { role: "user", content: "Convert it." },
    { role: "assistant", content: [{ type: "reasoning", text: "The user wants metric." }, { type: "text", text: "Done." }] },
  ];

  it("sends the provider's server-side context edit, so the history is shed like the live turn's", async () => {
    // Anthropic's history is never cleared on our side; without the edit the request
    // replays every tool body the turn's measured size had already shed.
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("summary") });
    const opts = contextManagementOptions("anthropic", DEFAULT_CONTEXT_LENGTH)!;
    await compactConversation(model, [], history, false, undefined, opts);
    expect(model.doGenerateCalls[0].providerOptions).toEqual(opts);
  });

  it("retries once with reasoning folded when the backend rejects its echo", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        if (JSON.stringify(prompt).includes('"type":"reasoning"')) {
          throw new Error("Invalid request: reasoning_content is not supported");
        }
        return generated("summary");
      },
    });
    expect(await compactConversation(model, [], history, true)).toEqual({ text: "summary", trust: true });
    expect(model.doGenerateCalls).toHaveLength(2);
    // Folded, not dropped: the reasoning is still in the summary's input.
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("The user wants metric.");
  });

  describe("past an overflow", () => {
    const body = "b".repeat(5_000);
    const input: ModelMessage[] = [
      { role: "user", content: "Read the ledger." },
      { role: "assistant", content: [
        { type: "reasoning", text: "Long scratch." },
        { type: "tool-call", toolCallId: "r1", toolName: "read_file", input: { path: "ledger.csv" } },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "r1", toolName: "read_file", output: { type: "text", value: body } }] },
      { role: "assistant", content: [{ type: "reasoning", text: "Long scratch." }, { type: "text", text: "The ledger balances." }] },
    ];
    const overflow = () => new Error("This model's maximum context length is 32768 tokens.");

    it("retries once with the tool bodies and reasoning shed, and every turn still in", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          const text = JSON.stringify(prompt);
          if (text.includes(body) || text.includes("Long scratch.")) throw overflow();
          return generated("summary");
        },
      });
      expect(await compactConversation(model, [], input, false)).toEqual({ text: "summary", trust: false });
      expect(model.doGenerateCalls).toHaveLength(2);
      const retried = JSON.stringify(model.doGenerateCalls[1].prompt);
      // Shed, not dropped: both turns and the call/result pair are still there.
      expect(retried).toContain("Read the ledger.");
      expect(retried).toContain("The ledger balances.");
      expect(retried).toContain(CLEARED_TOOL_OUTPUT);
      expect(retried.split('"toolCallId":"r1"').length - 1).toBe(2);
      expect(retried).toContain(COMPACTION_INSTRUCTION.split("\n")[0]);
    });

    it("gives up after that one retry", async () => {
      const model = new MockLanguageModelV3({ doGenerate: async () => { throw overflow(); } });
      expect(await compactConversation(model, [], input, false)).toBeNull();
      expect(model.doGenerateCalls).toHaveLength(2);
    });
  });
});
