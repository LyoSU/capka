import { describe, it, expect } from "vitest";
import {
  contextManagementOptions,
  mergeProviderOptions,
  clearsToolResultsClientSide,
  shouldClearToolResults,
  TOOL_CLEAR_TRIGGER_FRACTION,
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

  it("returns undefined for providers without a native edit yet (extension point)", () => {
    expect(contextManagementOptions("openai", 128_000)).toBeUndefined();
    expect(contextManagementOptions("google", 1_000_000)).toBeUndefined();
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
