import { describe, it, expect } from "vitest";
import {
  contextManagementOptions,
  mergeProviderOptions,
  clearsToolResultsClientSide,
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
