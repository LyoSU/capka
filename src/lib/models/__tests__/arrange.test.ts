import { describe, it, expect } from "vitest";
import { arrangeModels, variantLabel } from "@/lib/models/arrange";

const m = (id: string, name: string, extra: Partial<{ featured: boolean; configId: string }> = {}) => ({ id, name, ...extra });
const titles = (rows: ReturnType<typeof arrangeModels>) => rows.map((r) => r.model.name);
const ids = (rows: ReturnType<typeof arrangeModels>) => rows.map((r) => r.model.id);

describe("arrangeModels — order", () => {
  it("puts newer versions first and flagships above light tiers", () => {
    const rows = arrangeModels([
      m("gemini-2.0-flash-lite", "Gemini 2.0 Flash Lite"),
      m("gemini-2.5-flash", "Gemini 2.5 Flash"),
      m("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"),
      m("gemini-2.5-pro", "Gemini 2.5 Pro"),
      m("gemini-2.0-flash", "Gemini 2.0 Flash"),
    ]);
    expect(titles(rows)).toEqual([
      "Gemini 2.5 Pro",
      "Gemini 2.5 Flash",
      "Gemini 2.5 Flash Lite",
      "Gemini 2.0 Flash",
      "Gemini 2.0 Flash Lite",
    ]);
  });

  it("keeps families together, alphabetically, so a brand's lines do not interleave", () => {
    const rows = arrangeModels([
      m("o3", "o3"),
      m("gpt-4.1", "GPT 4.1"),
      m("gemma-3-27b", "Gemma 3 27b"),
      m("gpt-5", "GPT 5"),
      m("o4-mini", "o4 Mini"),
      m("gpt-4o", "GPT 4o"),
    ]);
    expect(titles(rows)).toEqual(["Gemma 3 27b", "GPT 5", "GPT 4.1", "GPT 4o", "o4 Mini", "o3"]);
  });

  it("orders 4.1 above 4o above 4", () => {
    const rows = arrangeModels([m("gpt-4", "GPT 4"), m("gpt-4.1", "GPT 4.1"), m("gpt-4o", "GPT 4o")]);
    expect(titles(rows)).toEqual(["GPT 4.1", "GPT 4o", "GPT 4"]);
  });

  it("puts bigger parameter counts first inside one version", () => {
    const rows = arrangeModels([m("llama-3.3-8b", "Llama 3.3 8b"), m("llama-3.3-70b", "Llama 3.3 70b")]);
    expect(titles(rows)).toEqual(["Llama 3.3 70b", "Llama 3.3 8b"]);
  });

  it("featured models come first regardless of version", () => {
    const rows = arrangeModels([m("gpt-5", "GPT 5"), m("gpt-4.1", "GPT 4.1", { featured: true })]);
    expect(titles(rows)).toEqual(["GPT 4.1", "GPT 5"]);
  });

  it("falls back to plain alphabetical order for names it cannot parse", () => {
    const rows = arrangeModels([m("b", "Zephyr Beta"), m("a", "auto"), m("c", "Hermes"), m("d", "QwQ")]);
    expect(titles(rows)).toEqual(["auto", "Hermes", "QwQ", "Zephyr Beta"]);
  });
});

describe("arrangeModels — collapsing snapshots", () => {
  it("folds rows with the same title into one, headed by the undated alias", () => {
    const rows = arrangeModels([
      m("gpt-3.5-turbo-0125", "GPT 3.5 Turbo"),
      m("gpt-3.5-turbo", "GPT 3.5 Turbo"),
      m("gpt-3.5-turbo-1106", "GPT 3.5 Turbo"),
      m("gpt-4", "GPT 4"),
    ]);
    expect(ids(rows)).toEqual(["gpt-4", "gpt-3.5-turbo"]);
    expect(rows[1].variants.map((v) => [v.model.id, v.label])).toEqual([
      ["gpt-3.5-turbo-0125", "0125"],
      ["gpt-3.5-turbo-1106", "1106"],
    ]);
  });

  it("uses the shortest id as head when there is no undated alias", () => {
    const rows = arrangeModels([
      m("gpt-4-turbo-2024-04-09", "GPT 4 Turbo"),
      m("gpt-4-turbo-preview", "GPT 4 Turbo"),
    ]);
    expect(ids(rows)).toEqual(["gpt-4-turbo-preview"]);
    expect(rows[0].variants[0].label).toBe("gpt-4-turbo-2024-04-09");
  });

  it("never folds across connections — the same model from two providers stays two rows", () => {
    const rows = arrangeModels([
      m("gpt-4o", "GPT 4o", { configId: "a" }),
      m("gpt-4o", "GPT 4o", { configId: "b" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.variants.length === 0)).toBe(true);
  });

  it("does not fold different titles even when ids share a prefix", () => {
    const rows = arrangeModels([m("gpt-4o", "GPT 4o"), m("gpt-4o-mini", "GPT 4o Mini")]);
    expect(rows).toHaveLength(2);
  });
});

describe("variantLabel", () => {
  it("is the tail past the head id, whatever separator the provider uses", () => {
    expect(variantLabel("gpt-4o", "gpt-4o-2024-08-06")).toBe("2024-08-06");
    expect(variantLabel("claude-3.7-sonnet", "anthropic/claude-3.7-sonnet:thinking")).toBe("thinking");
    expect(variantLabel("gemini-1.5-pro", "gemini-1.5-pro@001")).toBe("001");
  });

  it("is the whole slug when the ids are unrelated", () => {
    expect(variantLabel("gpt-4", "openai/chatgpt-4o-latest")).toBe("chatgpt-4o-latest");
  });
});
