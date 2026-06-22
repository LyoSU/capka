import { describe, it, expect } from "vitest";
import { parseModelsDevModels, canonId, matchModelsDev } from "../modelsdev";

const SAMPLE = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-1": {
        id: "claude-opus-4-1",
        name: "Claude Opus 4.1",
        knowledge: "2025-03",
        open_weights: false,
        cost: { input: 15, output: 75 },
        limit: { context: 200000, output: 32000 },
      },
    },
  },
  meta: {
    id: "meta",
    name: "Meta",
    models: {
      "llama-4-scout": { id: "llama-4-scout", name: "Llama 4 Scout", open_weights: true },
      // No knowledge AND no open_weights flag → nothing to enrich → dropped.
      "llama-mystery": { id: "llama-mystery", name: "Llama Mystery" },
    },
  },
};

describe("parseModelsDevModels", () => {
  it("flattens providers→models into metas, keeping only enrichable entries", () => {
    const metas = parseModelsDevModels(SAMPLE);
    expect(metas).toContainEqual({ bareId: "claude-opus-4-1", cutoff: "2025-03", openWeights: false });
    expect(metas).toContainEqual({ bareId: "llama-4-scout", cutoff: null, openWeights: true });
    // "llama-mystery" has neither cutoff nor an open_weights flag → excluded.
    expect(metas.find((m) => m.bareId === "llama-mystery")).toBeUndefined();
  });

  it("never throws on malformed input", () => {
    expect(parseModelsDevModels(null)).toEqual([]);
    expect(parseModelsDevModels({ x: { models: "nope" } })).toEqual([]);
  });
});

describe("canonId", () => {
  it("collapses dots, underscores, and case so dotted/hyphenated ids converge", () => {
    expect(canonId("anthropic/claude-opus-4.1")).toBe(canonId("claude-opus-4-1"));
    expect(canonId("openai/GPT-4.1")).toBe("gpt-4-1");
  });
});

describe("matchModelsDev", () => {
  it("maps Models.dev metas onto existing catalog ids across the dot/hyphen gap", () => {
    const metas = parseModelsDevModels(SAMPLE);
    const existing = ["anthropic/claude-opus-4.1", "meta/llama-4-scout", "openai/gpt-4.1"];
    const updates = matchModelsDev(metas, existing);
    expect(updates).toContainEqual({ id: "anthropic/claude-opus-4.1", cutoff: "2025-03", openWeights: false });
    expect(updates).toContainEqual({ id: "meta/llama-4-scout", cutoff: null, openWeights: true });
    // gpt-4.1 has no Models.dev meta in the sample → no update row for it.
    expect(updates.find((u) => u.id === "openai/gpt-4.1")).toBeUndefined();
  });
});
