import { describe, it, expect } from "vitest";
import { generateText, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";
import {
  contextManagementOptions,
  mergeProviderOptions,
  clearsToolResultsClientSide,
  shouldClearToolResults,
  contextIsDeep,
  thinkingIsDeep,
  thinkingClearTrigger,
  markStepTail,
  mergeUserRuns,
  toolClearTrigger,
  TOOL_CLEAR_TRIGGER_FRACTION,
  TOOL_CLEAR_TRIGGER_MAX,
  TOOL_CLEAR_KEEP_LAST,
} from "@/lib/chat/context/provider-edits";

describe("contextManagementOptions", () => {
  it("enables Anthropic's native clear_tool_uses, scaled to the effective limit", () => {
    const opts = contextManagementOptions("anthropic", 200_000) as {
      anthropic: { contextManagement: { edits: Array<Record<string, unknown>> } };
    };
    const edit = opts.anthropic.contextManagement.edits[0] as {
      type: string; trigger: { value: number }; keep: { value: number };
    };
    expect(edit.type).toBe("clear_tool_uses_20250919");
    expect(edit.trigger.value).toBeGreaterThan(0);
    expect(edit.trigger.value).toBeLessThan(200_000); // fires before the hard limit
    expect(edit.keep.value).toBeGreaterThan(0);
  });

  it("does NOT clear thinking while the conversation is shallow", () => {
    // The strategy has no `trigger` of its own — it applies on EVERY request — and
    // clearing invalidates the cache from the clearing point. In a tool loop each
    // step adds a thinking turn, so the cleared SET changes every step and the cache
    // never settles. Attaching it unconditionally would cost more than it saves.
    const opts = contextManagementOptions("anthropic", 200_000) as {
      anthropic: { contextManagement: { edits: Array<{ type: string }> } };
    };
    expect(opts.anthropic.contextManagement.edits.map((e) => e.type)).toEqual(["clear_tool_uses_20250919"]);
  });

  it("clears thinking once the conversation is deep, and lists it FIRST", () => {
    // Deep is where window headroom, not cache economy, is the binding constraint —
    // the same point the tool-clearing trigger is set at. And the docs require
    // clear_thinking to come first in `edits` when strategies are combined.
    const opts = contextManagementOptions("anthropic", 200_000, true) as {
      anthropic: { contextManagement: { edits: Array<{ type: string; keep?: { type: string; value: number } }> } };
    };
    const edits = opts.anthropic.contextManagement.edits;
    expect(edits.map((e) => e.type)).toEqual(["clear_thinking_20251015", "clear_tool_uses_20250919"]);
    expect(edits[0].keep).toEqual({ type: "thinking_turns", value: TOOL_CLEAR_KEEP_LAST });
  });

  it("returns undefined for providers without a native edit yet (extension point)", () => {
    expect(contextManagementOptions("openai", 128_000)).toBeUndefined();
    expect(contextManagementOptions("google", 1_000_000)).toBeUndefined();
  });

  it("clears the CALL's arguments too, not just its result", () => {
    // Results-only aims the mechanism at the lighter half: a bulk upsert carries the
    // row in its arguments and gets an id back. Without this the edit fires, sheds a
    // few hundred tokens, and a long write turn still rides to the ceiling.
    const opts = contextManagementOptions("anthropic", 200_000) as {
      anthropic: { contextManagement: { edits: Array<{ clearToolInputs?: boolean }> } };
    };
    expect(opts.anthropic.contextManagement.edits[0].clearToolInputs).toBe(true);
  });
});

describe("toolClearTrigger", () => {
  it("scales with small windows, where a flat ceiling would never fire", () => {
    expect(toolClearTrigger(32_000)).toBe(16_000);
    expect(toolClearTrigger(200_000)).toBe(100_000);
  });

  it("caps what 'half the window' may mean on a very large one", () => {
    // Half of 1M is half a MILLION tokens of accumulated tool traffic before
    // anything is shed — past where recall degrades and absurd to replay per step.
    expect(toolClearTrigger(1_000_000)).toBe(TOOL_CLEAR_TRIGGER_MAX);
    expect(toolClearTrigger(1_000_000)).toBeLessThan(1_000_000 * TOOL_CLEAR_TRIGGER_FRACTION);
  });

  it("is the single source both enforcement sites read", () => {
    const opts = contextManagementOptions("anthropic", 1_000_000) as {
      anthropic: { contextManagement: { edits: Array<{ trigger: { value: number } }> } };
    };
    expect(opts.anthropic.contextManagement.edits[0].trigger.value).toBe(toolClearTrigger(1_000_000));
    // …and the client-side gate agrees, at the same number, on a provider without
    // a native edit.
    expect(shouldClearToolResults("openai", [{ metadata: { contextTokens: toolClearTrigger(1_000_000) } }], 1_000_000)).toBe(true);
    expect(shouldClearToolResults("openai", [{ metadata: { contextTokens: toolClearTrigger(1_000_000) - 1 } }], 1_000_000)).toBe(false);
  });
});

describe("clearsToolResultsClientSide", () => {
  // The policy has two enforcement sites — Anthropic's server-side edit and our
  // own buildModelContext pass — and exactly one of them must run per provider.
  // If this predicate ever disagreed with contextManagementOptions, a provider
  // would either clear twice or (as it did before) not at all.
  it("is the exact complement of having a native edit", () => {
    for (const p of ["anthropic", "openai", "google", "ollama", "openrouter"]) {
      expect(clearsToolResultsClientSide(p)).toBe(contextManagementOptions(p, 200_000) === undefined);
    }
  });

  it("drives Anthropic's trigger from the SAME shared policy the client path uses", () => {
    const opts = contextManagementOptions("anthropic", 200_000) as {
      anthropic: { contextManagement: { edits: Array<{ trigger: { value: number }; keep: { value: number } }> } };
    };
    const edit = opts.anthropic.contextManagement.edits[0];
    expect(edit.trigger.value).toBe(Math.round(200_000 * TOOL_CLEAR_TRIGGER_FRACTION));
    expect(edit.keep.value).toBe(TOOL_CLEAR_KEEP_LAST);
  });
});

describe("shouldClearToolResults", () => {
  const LIMIT = 200_000;
  const half = LIMIT * TOOL_CLEAR_TRIGGER_FRACTION;
  const turn = (m: Record<string, unknown>) => ({ metadata: m });

  it("leaves it to the provider when the provider does it server-side", () => {
    // Clearing client-side AND server-side would drop twice as much as the policy says.
    expect(shouldClearToolResults("anthropic", [turn({ contextTokens: LIMIT })], LIMIT)).toBe(false);
  });

  it("stays off while the conversation is still shallow", () => {
    expect(shouldClearToolResults("openai", [turn({ contextTokens: half - 1 })], LIMIT)).toBe(false);
    expect(shouldClearToolResults("openai", [], LIMIT)).toBe(false);
  });

  it("turns on once the last measured prompt reaches the threshold", () => {
    expect(shouldClearToolResults("openai", [turn({ contextTokens: half })], LIMIT)).toBe(true);
  });

  it("STAYS on after clearing drops the measurement back under the threshold", () => {
    // The oscillation this exists to prevent: the cleared turn measures small, so a
    // fresh decision would switch clearing back off, replay every tool body, blow
    // past the threshold again — full → cleared → full, with a different prefix each
    // time (so the prompt cache misses on both) and the tool bodies back in the bill.
    const path = [turn({ contextTokens: half }), turn({ contextTokens: 1_000, toolsCleared: true })];
    expect(shouldClearToolResults("openai", path, LIMIT)).toBe(true);
  });

  it("resets at a compaction checkpoint — sticky, not permanent", () => {
    // Compaction collapses everything up to the checkpoint into a summary, so the
    // model's view genuinely restarts small. Messages before it aren't in that view
    // and don't get a vote; otherwise the first deep stretch of a chat would clear
    // tool bodies for the rest of its life.
    const path = [
      turn({ contextTokens: half, toolsCleared: true }),
      turn({ compaction: { summary: "…", summarizedUpTo: "m1" } }),
      turn({ contextTokens: 2_000 }),
    ];
    expect(shouldClearToolResults("openai", path, LIMIT)).toBe(false);
  });

  it("re-arms after a checkpoint when the fresh zone grows deep again", () => {
    const path = [
      turn({ compaction: { summary: "…", summarizedUpTo: "m1" } }),
      turn({ contextTokens: half + 1 }),
    ];
    expect(shouldClearToolResults("openai", path, LIMIT)).toBe(true);
  });
});

describe("the thinking gate has its own threshold", () => {
  const turn = (m: Record<string, unknown>) => ({ metadata: m });

  it("does NOT inherit the tool trigger's cap", () => {
    // The cap is right for tool traffic and inverted for thinking. Sharing one
    // number made this gate fire at 12% of a 1M window — and it is sticky, so it
    // then stayed on for the rest of the conversation, paying a cache transition
    // per step to shed tokens that were being read at cache rate.
    expect(toolClearTrigger(1_000_000)).toBe(TOOL_CLEAR_TRIGGER_MAX);
    expect(thinkingClearTrigger(1_000_000)).toBe(500_000);
    expect(thinkingClearTrigger(1_000_000)).toBeGreaterThan(toolClearTrigger(1_000_000));
  });

  it("still scales down, so a large flat number could not replace it", () => {
    // The fraction is what makes this fire at all on a small window.
    expect(thinkingClearTrigger(32_000)).toBe(16_000);
    expect(thinkingIsDeep([turn({ contextTokens: 16_000 })], 32_000)).toBe(true);
  });

  it("stays off on a large window where tool clearing has already turned on", () => {
    // 120k is half of a 240k window's trigger and 12% of this one: deep enough to
    // shed tool bodies, nowhere near where carrying thinking stops fitting.
    const path = [turn({ contextTokens: 120_000 })];
    expect(contextIsDeep(path, 1_000_000)).toBe(true);
    expect(thinkingIsDeep(path, 1_000_000)).toBe(false);
  });

  it("turns on at its own threshold, and stays on once it has", () => {
    expect(thinkingIsDeep([turn({ contextTokens: 500_000 })], 1_000_000)).toBe(true);
    // Sticky for the same reason tool clearing is: shedding shrinks the very
    // measurement that triggered it, so a fresh answer each turn would oscillate
    // and hand the cache a different prefix every other turn.
    const after = [turn({ contextTokens: 500_000, contextDeep: true }), turn({ contextTokens: 9_000 })];
    expect(thinkingIsDeep(after, 1_000_000)).toBe(true);
  });

  it("does NOT take `toolsCleared` as evidence, though contextIsDeep does", () => {
    // `toolsCleared` is only ever written by a provider with no server-side edit,
    // and is earned at the LOWER tool threshold. A chat that changed model
    // mid-conversation would otherwise carry that stickiness into this gate and
    // turn the edit on early and permanently.
    const path = [turn({ contextTokens: 1_000, toolsCleared: true })];
    expect(contextIsDeep(path, 1_000_000)).toBe(true);
    expect(thinkingIsDeep(path, 1_000_000)).toBe(false);
  });

  it("resets at a compaction checkpoint, like every other shed decision", () => {
    const path = [
      turn({ contextTokens: 500_000, contextDeep: true }),
      turn({ compaction: { summary: "…", summarizedUpTo: "m1" } }),
      turn({ contextTokens: 20_000 }),
    ];
    expect(thinkingIsDeep(path, 1_000_000)).toBe(false);
  });
});

describe("markStepTail", () => {
  type Msg = { role: string; providerOptions?: Record<string, Record<string, unknown>> };
  const marker = { anthropic: { cacheControl: { type: "ephemeral" } } };

  it("leaves step 0 alone — its tail is the already-marked user message", () => {
    const msgs: Msg[] = [{ role: "user" }, { role: "assistant" }];
    expect(markStepTail(msgs, 0, marker)).toBe(msgs);
  });

  it("marks only the tail, and only the tail", () => {
    const msgs: Msg[] = [{ role: "user" }, { role: "assistant" }, { role: "tool" }];
    const out = markStepTail(msgs, 3, marker);
    expect(out.at(-1)?.providerOptions).toEqual(marker);
    expect(out.slice(0, -1).every((m) => m.providerOptions === undefined)).toBe(true);
  });

  it("does NOT mutate the messages it was given", () => {
    // The ceiling bug this guards: the SDK hands back the SAME objects each step, so
    // an in-place marker accumulates one breakpoint per step. Anthropic allows four
    // (stable + previous turn's tail + user tail + this), and a 25-step tool loop would blow past
    // it — the request fails outright rather than degrading.
    const msgs: Msg[] = [{ role: "user" }, { role: "tool" }];
    const before = JSON.stringify(msgs);
    const out = markStepTail(msgs, 1, marker);
    expect(JSON.stringify(msgs)).toBe(before);
    expect(out).not.toBe(msgs);
    expect(out.at(-1)).not.toBe(msgs.at(-1));
  });

  it("marking step after step never accumulates markers", () => {
    let msgs: Msg[] = [{ role: "user" }];
    for (let step = 1; step <= 5; step++) {
      msgs = [...markStepTail(msgs, step, marker), { role: "tool" }];
    }
    // One breakpoint per step would be five; the moving marker leaves exactly the
    // ones still sitting at a tail position of some earlier prefix — never a fifth
    // live marker on the message the current step actually sends.
    expect(msgs.at(-1)?.providerOptions).toBeUndefined();
  });
});

describe("mergeProviderOptions", () => {
  it("deep-merges options targeting the same provider namespace", () => {
    const reasoning = { anthropic: { thinking: { type: "enabled" } } };
    const ctx = { anthropic: { contextManagement: { edits: [] } } };
    expect(mergeProviderOptions(reasoning, ctx)).toEqual({
      anthropic: { thinking: { type: "enabled" }, contextManagement: { edits: [] } },
    });
  });

  it("ignores undefined inputs and returns undefined when nothing is set", () => {
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
    expect(mergeProviderOptions({ openrouter: { reasoning: {} } }, undefined)).toEqual({
      openrouter: { reasoning: {} },
    });
  });
});

describe("contextIsDeep", () => {
  const LIMIT = 200_000;
  const half = LIMIT * TOOL_CLEAR_TRIGGER_FRACTION;
  const turn = (m: Record<string, unknown>) => ({ metadata: m });

  it("is the provider-blind half of the decision, so Anthropic gets an answer too", () => {
    // shouldClearToolResults returns false for Anthropic by design — it asks whether
    // WE should clear. The depth question is separate, and the server-side edits need
    // it: without it the thinking edit has no gate on the one provider that has one.
    expect(contextIsDeep([turn({ contextTokens: half })], LIMIT)).toBe(true);
    expect(contextIsDeep([turn({ contextTokens: half - 1 })], LIMIT)).toBe(false);
  });

  it("stays on once decided, so the answer cannot oscillate turn to turn", () => {
    const path = [turn({ contextTokens: half }), turn({ contextTokens: 1_000, contextDeep: true })];
    expect(contextIsDeep(path, LIMIT)).toBe(true);
  });

  it("still honours the older marker, so a chat mid-flight does not flip", () => {
    // `toolsCleared` was this signal's only name before it had a provider-blind one.
    const path = [turn({ contextTokens: half }), turn({ contextTokens: 1_000, toolsCleared: true })];
    expect(contextIsDeep(path, LIMIT)).toBe(true);
  });

  it("resets at a compaction checkpoint", () => {
    const path = [
      turn({ contextTokens: half, contextDeep: true }),
      turn({ compaction: { summary: "…", summarizedUpTo: "m1" } }),
      turn({ contextTokens: 2_000 }),
    ];
    expect(contextIsDeep(path, LIMIT)).toBe(false);
  });
});

describe("mergeUserRuns", () => {
  const marker = { anthropic: { cacheControl: { type: "ephemeral" } } };
  const CONTEXT = "<turn-context>\nworkspace: a.txt\n</turn-context>";
  // Turn 1 as the runner sends it: the user's message carries the history breakpoint
  // and the turn context follows. Turn 2 replays that message WITHOUT the context,
  // marked as the previous turn's tail.
  const turn1 = (): ModelMessage[] => [
    { role: "system", content: "persona", providerOptions: marker },
    { role: "user", content: [{ type: "text", text: "hello" }], providerOptions: marker },
    { role: "user", content: CONTEXT },
  ];
  const turn2 = (): ModelMessage[] => [
    { role: "system", content: "persona", providerOptions: marker },
    { role: "user", content: [{ type: "text", text: "hello" }], providerOptions: marker },
    { role: "assistant", content: "Noted." },
    { role: "user", content: [{ type: "text", text: "and now?" }], providerOptions: marker },
    { role: "user", content: CONTEXT },
  ];

  /** The request body a real provider package builds for `messages`. */
  async function wire(provider: "anthropic" | "openai-compatible" | "openai" | "ollama" | "google", messages: ModelMessage[]) {
    let body: Record<string, unknown> | undefined;
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      throw new Error("captured");
    };
    const model = {
      anthropic: () => createAnthropic({ apiKey: "k", fetch })("claude-sonnet-4-5"),
      "openai-compatible": () => createOpenAICompatible({ name: "vllm", baseURL: "http://vllm.test/v1", fetch })("gemma"),
      openai: () => createOpenAI({ apiKey: "k", baseURL: "http://vllm.test/v1", fetch }).chat("gemma"),
      ollama: () => createOllama({ baseURL: "http://ollama.test/api", fetch })("llama3"),
      google: () => createGoogleGenerativeAI({ apiKey: "k", fetch })("gemini-2.5-flash"),
    }[provider]();
    await generateText({ model, messages, maxRetries: 0 }).catch(() => {});
    return body as {
      system?: unknown;
      messages: { role: string; content: unknown; images?: unknown[] }[];
      contents: { role: string; parts: { text?: string }[] }[];
    };
  }
  const roles = (msgs: { role: string }[]) => msgs.map((m) => m.role);
  const consecutiveUsers = (msgs: { role: string }[]) =>
    msgs.filter((m, i) => m.role === "user" && msgs[i - 1]?.role === "user").length;

  it("folds the turn context into the user's message and keeps the breakpoint on the user's own part", () => {
    const out = mergeUserRuns(turn1(), "anthropic");
    expect(roles(out)).toEqual(["system", "user"]);
    const user = out[1] as { content: { text: string; providerOptions?: unknown }[]; providerOptions?: unknown };
    expect(user.providerOptions).toBeUndefined();
    expect(user.content.map((p) => p.text)).toEqual(["hello", CONTEXT]);
    expect(user.content[0].providerOptions).toEqual(marker);
    expect(user.content[1].providerOptions).toBeUndefined();
  });

  it("returns the list itself when nothing needs folding, and never mutates it", () => {
    const alternating: ModelMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
    expect(mergeUserRuns(alternating, "vllm")).toBe(alternating);
    for (const provider of ["anthropic", "vllm"]) {
      const msgs = turn2();
      const before = JSON.stringify(msgs);
      mergeUserRuns(msgs, provider);
      expect(JSON.stringify(msgs)).toBe(before);
    }
  });

  it("folds a run of three (context, then an effect note or a steer) in order", () => {
    const run = [...turn1(), { role: "user", content: "already ran: save_row" } as const];
    const out = mergeUserRuns(run, "anthropic");
    expect(roles(out)).toEqual(["system", "user"]);
    expect((out[1].content as { text: string }[]).map((p) => p.text)).toEqual(["hello", CONTEXT, "already ran: save_row"]);
    // Elsewhere the same run is one string, each folded message on a line of its own.
    expect(mergeUserRuns(run, "vllm")[1].content).toBe(`hello\n\n${CONTEXT}\n\nalready ran: save_row`);
  });

  it("puts the marker on the last part the SDK keeps, not on an empty text it drops", () => {
    const out = mergeUserRuns([
      { role: "user", content: [{ type: "file", data: "aGk=", mediaType: "image/png" }, { type: "text", text: "" }], providerOptions: marker },
      { role: "user", content: CONTEXT },
    ], "anthropic");
    const parts = out[0].content as { type: string; providerOptions?: unknown }[];
    expect(parts[0].providerOptions).toEqual(marker);
    expect(parts[1].providerOptions).toBeUndefined();
  });

  it.each(["openai-compatible", "openai"] as const)("sends %s no two user messages in a row, and text as one string", async (provider) => {
    // Control: unfolded, the package sends the run as it is — the 400 on a strict template.
    expect(consecutiveUsers((await wire(provider, turn2())).messages)).toBe(1);
    const body = await wire(provider, mergeUserRuns(turn2(), provider));
    expect(roles(body.messages)).toEqual(["system", "user", "assistant", "user"]);
    // A string, as a lone text part goes out: some text-only backends 400 on an array.
    expect(body.messages.at(-1)!.content).toBe(`and now?\n\n${CONTEXT}`);
  });

  it("keeps the user's words apart from the context on Ollama, which joins parts with nothing", async () => {
    // An attachment keeps the fold in parts, so the package's own join is what runs.
    const run: ModelMessage[] = [
      { role: "user", content: [{ type: "file", data: "aGk=", mediaType: "image/png" }, { type: "text", text: "what is this" }], providerOptions: marker },
      { role: "user", content: CONTEXT },
    ];
    // Control: unfolded, two user messages.
    expect(consecutiveUsers((await wire("ollama", run)).messages)).toBe(1);
    const [user] = (await wire("ollama", mergeUserRuns(run, "ollama"))).messages;
    expect(user.content).toBe(`what is this\n\n${CONTEXT}`);
    expect(user.images).toHaveLength(1);
  });

  it("sends Google one user turn with the words and the context apart", async () => {
    // Control: unfolded, the package sends the run as two user turns of its own.
    expect(consecutiveUsers((await wire("google", turn2())).contents)).toBe(1);
    const body = await wire("google", mergeUserRuns(turn2(), "google"));
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents.at(-1)!.parts.map((p) => p.text).join("")).toBe(`and now?\n\n${CONTEXT}`);
  });

  it("sends Anthropic the same request as before, so the next turn's prefix is still a cache hit", async () => {
    const [t1, t2] = [await wire("anthropic", mergeUserRuns(turn1(), "anthropic")), await wire("anthropic", mergeUserRuns(turn2(), "anthropic"))];
    // Anthropic folds a run itself, so folding first changes nothing on its wire…
    expect(await wire("anthropic", turn2())).toEqual(t2);
    // …and turn 2 replays turn 1 byte for byte up to and including the marked block
    // on the user's own words; only the turn context after it is gone.
    const first = (t1.messages[0].content as unknown[]);
    expect(t2.system).toEqual(t1.system);
    expect(t2.messages[0].content).toEqual(first.slice(0, 1));
    expect(first[0]).toMatchObject({ text: "hello", cache_control: { type: "ephemeral" } });
    expect(first[1]).toEqual({ type: "text", text: CONTEXT });
    // Stable + previous tail + this tail: three, leaving the step tail the fourth.
    expect(JSON.stringify(t2).match(/cache_control/g)).toHaveLength(3);
  });
});
