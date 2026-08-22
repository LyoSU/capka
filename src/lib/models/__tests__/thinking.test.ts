import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  availableAmounts,
  clampAmount,
  effortSpread,
  parseThinkAmount,
  reasoningParams,
} from "@/lib/models/thinking";

// The enums below are REAL, verified against live APIs or vendor docs. They exist
// as a set precisely because their intersection is empty — that's the whole reason
// the app maps intent onto a per-model enum instead of sending a fixed string.
const KIMI = ["low", "high", "max"]; // Moonshot Kimi K3 (verified live)
const GROQ_QWEN = ["none", "default"]; // Groq Qwen 3.6
const GROQ_OSS = ["low", "medium", "high"]; // Groq GPT-OSS
const OPENAI = ["none", "minimal", "low", "medium", "high"]; // OpenAI GPT-5.x

describe("effortSpread", () => {
  it("spreads by position so every stop is a value the model accepts", () => {
    expect(effortSpread(KIMI)).toEqual({ brief: "low", balanced: "high", deep: "max" });
    expect(effortSpread(GROQ_OSS)).toEqual({ brief: "low", balanced: "medium", deep: "high" });
    // 4 on-values: the middle rounds UP, so "balanced" stays medium rather than
    // quietly becoming a weaker setting than it has always been.
    expect(effortSpread(OPENAI)).toEqual({ brief: "minimal", balanced: "medium", deep: "high" });
  });

  it("collapses to one stop when the model has a single 'on' value", () => {
    // Groq's Qwen models take only none|default — three stops would be a lie.
    expect(effortSpread(GROQ_QWEN)).toEqual({ balanced: "default" });
  });

  it("treats a two-value enum as extremes, not a spectrum", () => {
    expect(effortSpread(["low", "high"])).toEqual({ brief: "low", deep: "high" });
  });

  it("never offers a stop when the model can only be asked NOT to think", () => {
    expect(effortSpread(["none"])).toEqual({});
  });

  it("falls back to the portable guess when the enum isn't known yet", () => {
    expect(effortSpread(null)).toEqual({ brief: "low", balanced: "medium", deep: "high" });
    expect(effortSpread([])).toEqual({ brief: "low", balanced: "medium", deep: "high" });
  });

  it("passes an unknown token through rather than inventing a legal value", () => {
    // An exotic gateway's own vocabulary: we can't rank it, but the provider
    // itself enumerated it, so it IS accepted — using it beats guessing.
    expect(effortSpread(["turbo"])).toEqual({ balanced: "turbo" });
  });

  it("is case- and whitespace-insensitive (error text is prose, not a schema)", () => {
    expect(effortSpread([" Low ", "HIGH"])).toEqual({ brief: "low", deep: "high" });
  });
});

describe("availableAmounts", () => {
  it("always offers 'off' — omitting the parameter is legal everywhere", () => {
    // This is what makes "don't think" the one setting that can never 400.
    expect(availableAmounts("litellm", GROQ_QWEN)).toEqual(["off", "balanced"]);
    expect(availableAmounts("groq", KIMI)).toEqual(["off", "brief", "balanced", "deep"]);
  });

  it("offers every stop on a budget provider, whatever the enum says", () => {
    // Anthropic/Google take a token budget, so there's no enum to be out of.
    for (const p of ["anthropic", "bedrock", "google", "vertex"]) {
      expect(availableAmounts(p, GROQ_QWEN)).toEqual(["off", "brief", "balanced", "deep"]);
    }
  });

  it("offers nothing for a provider with no reasoning knob", () => {
    expect(availableAmounts("ollama", null)).toEqual([]);
  });
});

describe("clampAmount", () => {
  it("snaps a stored amount onto what the current model can do", () => {
    // A chat set to "deep" then switched to a Qwen model that has one level.
    expect(clampAmount("deep", ["off", "balanced"])).toBe("balanced");
    // …and onto the nearest stop when the middle is missing.
    expect(clampAmount("balanced", ["off", "brief", "deep"])).toBe("brief");
  });

  it("keeps the amount when it's available", () => {
    expect(clampAmount("brief", ["off", "brief", "deep"])).toBe("brief");
  });

  it("falls back to off when the model has no levels at all", () => {
    expect(clampAmount("deep", [])).toBe("off");
  });
});

describe("parseThinkAmount", () => {
  it("reads a stored value and defaults anything else to the historical behaviour", () => {
    expect(parseThinkAmount("deep")).toBe("deep");
    expect(parseThinkAmount(null)).toBe("balanced");
    expect(parseThinkAmount("medium")).toBe("balanced"); // a provider value is NOT an amount
  });
});

describe("reasoningParams", () => {
  it("sends nothing at all for 'off' — that's why it can't be rejected", () => {
    for (const p of ["anthropic", "openai", "openrouter", "litellm", "google"]) {
      expect(reasoningParams(p, "off")).toBeUndefined();
    }
  });

  it("maps intent to a token budget on the budget providers", () => {
    expect(reasoningParams("anthropic", "balanced")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4000 } },
    });
    // 1024 is Anthropic's documented minimum — "brief" can't go under it.
    expect(reasoningParams("anthropic", "brief")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
    });
    expect(reasoningParams("google", "deep")).toEqual({
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
    });
    expect(reasoningParams("vertex", "brief")).toEqual({
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } },
    });
  });

  it("uses the model's own enum on the OpenAI-compatible family", () => {
    // The bug that started this: "medium" is what we used to hardcode, and Kimi
    // rejects it outright. Same intent, legal value.
    expect(reasoningParams("litellm", "balanced", KIMI)).toEqual({ litellm: { reasoningEffort: "high" } });
    expect(reasoningParams("groq", "balanced", GROQ_QWEN)).toEqual({ groq: { reasoningEffort: "default" } });
    expect(reasoningParams("xai", "brief", ["low", "medium", "high"])).toEqual({ xai: { reasoningEffort: "low" } });
  });

  it("keeps the namespace and wrapper each provider expects", () => {
    expect(reasoningParams("openrouter", "deep", null)).toEqual({
      openrouter: { reasoning: { enabled: true, effort: "high" } },
    });
    // Responses API: the effort AND the summary knob, or the thinking is invisible.
    expect(reasoningParams("openai", "balanced", null)).toEqual({
      openai: { reasoningSummary: "auto", reasoningEffort: "medium" },
    });
    expect(reasoningParams("azure", "balanced", null)).toEqual({
      azure: { reasoningSummary: "auto", reasoningEffort: "medium" },
    });
  });

  it("sends nothing when the requested stop has no legal value on this model", () => {
    // "deep" on a single-level enum: better to think at the level it has (via the
    // clamped amount) than to invent a value — the caller clamps first, and if it
    // somehow doesn't, we send nothing rather than a 400.
    expect(reasoningParams("groq", "deep", GROQ_QWEN)).toBeUndefined();
    expect(reasoningParams("litellm", "brief", ["none"])).toBeUndefined();
  });

  it("sends nothing for a provider with no knob", () => {
    expect(reasoningParams("ollama", "deep")).toBeUndefined();
  });
});

// ── Learned capabilities survive a catalog re-sync ───────────
//
// `efforts` — the enum the tests above consume — is LEARNED from a provider
// rejection rather than reported by any source, so a catalog re-sync must carry
// it forward or the model pays the negotiation request again on every turn,
// forever and silently. It lives here because it is a reasoning capability; the
// clause that preserves it is SQL inside a module-private `upsertModels`, so
// this asserts on the source.
//
// Not hypothetical: that clause shipped carrying `efforts` alone and dropped any
// other learned key in BOTH branches, so the next such key would have survived
// only until the first resync. The rule was in a comment; the guard covered one
// key.
const modelsSrc = (f: string) => readFileSync(join(process.cwd(), "src/lib/models", f), "utf8");

function learnedKeys(): string[] {
  // Each entry is a docblock (which may say LEARNED) followed by `name?: type;`.
  const keys: string[] = [];
  for (const m of modelsSrc("normalize.ts").matchAll(/\/\*\*([\s\S]*?)\*\/\s*(\w+)\??:/g)) {
    if (m[1].includes("LEARNED")) keys.push(m[2]);
  }
  return keys;
}

describe("learned capabilities survive a catalog re-sync", () => {
  it("marks at least the two keys we know are learned", () => {
    // Guards the guard: rename the LEARNED marker convention away and the key
    // list empties, which would make the assertions below pass vacuously.
    expect(learnedKeys()).toEqual(expect.arrayContaining(["efforts", "noReasoning"]));
  });

  it("names every learned key in the upsert preserve clause", () => {
    const clause = modelsSrc("catalog.ts").match(/jsonb_strip_nulls\(jsonb_build_object\(([\s\S]*?)\)\)/);
    expect(clause, "the preserve clause in upsertModels moved or was rewritten").not.toBeNull();
    // The keys the clause BUILDS, not every quoted string in it. Each pair reads
    // `'key', <expr>` and the expr repeats the name (`capabilities -> 'key'`), so
    // a substring check passes even when the built key has been renamed away — it
    // matches the extraction half. Written that weaker way first, it survived
    // deleting the very key it was added to protect.
    const built = [...clause![1].matchAll(/'(\w+)',/g)].map((m) => m[1]);
    for (const key of learnedKeys()) {
      expect(built, `re-sync would wipe the learned '${key}'`).toContain(key);
    }
  });

  it("drops the read cache for every learned key after a sync", () => {
    // Same failure one layer up: the row keeps the key but a warm cache serves
    // the pre-sync answer.
    const catalog = modelsSrc("catalog.ts");
    const sync = catalog.slice(catalog.indexOf("priceCache.clear()"), catalog.indexOf("return { openrouter: or"));
    for (const key of learnedKeys()) {
      const cache = key === "efforts" ? "effortsCache" : "noReasoningCache";
      expect(sync, `${cache} is not cleared on sync`).toContain(`${cache}.clear()`);
    }
  });
});
