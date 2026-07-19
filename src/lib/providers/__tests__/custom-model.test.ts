import { describe, it, expect } from "vitest";
import { customModelOption } from "../custom-model";
import type { ModelInfo } from "../list-models";

const sample: ModelInfo = {
  id: "openrouter/auto",
  name: "Auto",
  provider: "OpenRouter",
  context: 128000,
  pricing: { prompt: 1, completion: 2 },
  capabilities: { vision: true, tools: true, reasoning: true },
  configId: "cfg_1",
  configLabel: "My OpenRouter",
  configIcon: "openrouter",
  configProvider: "openrouter",
};

describe("customModelOption", () => {
  it("offers a fully-qualified, unlisted model id (e.g. a stealth model) as a selectable option", () => {
    const opt = customModelOption("openrouter/owl-alpha", sample);
    expect(opt).not.toBeNull();
    expect(opt!.id).toBe("openrouter/owl-alpha");
    expect(opt!.capabilities?.tools).toBe(true); // so the picker's hasTools filter keeps it
  });

  it("binds the custom id to the active connection so the run uses the right key", () => {
    const opt = customModelOption("openrouter/owl-alpha", sample)!;
    expect(opt.configId).toBe("cfg_1");
    expect(opt.configProvider).toBe("openrouter");
  });

  it("preserves the id's original case (model ids are case-sensitive)", () => {
    expect(customModelOption("Provider/Owl-Alpha", sample)!.id).toBe("Provider/Owl-Alpha");
  });

  it("ignores a non-id-shaped query so it doesn't offer 'custom' for every search", () => {
    expect(customModelOption("owl", sample)).toBeNull();
    expect(customModelOption("gpt 5", sample)).toBeNull();
    expect(customModelOption("  ", sample)).toBeNull();
  });

  it("works without a sample connection (bare id, default config routing)", () => {
    const opt = customModelOption("openrouter/owl-alpha", undefined);
    expect(opt).not.toBeNull();
    expect(opt!.configId).toBeUndefined();
  });

  // Azure model ids are DEPLOYMENT names — user-chosen bare words the data
  // plane offers no way to list, so a typed bare name must be selectable.
  describe("Azure deployment names (bare ids)", () => {
    const azureSample: ModelInfo = { ...sample, configProvider: "azure", configId: "cfg_az" };

    it("offers a bare typed id for an Azure connection", () => {
      const opt = customModelOption("gpt5mini", azureSample);
      expect(opt?.id).toBe("gpt5mini");
      expect(opt?.configId).toBe("cfg_az");
    });

    it("still rejects non-name-shaped input (spaces, empty)", () => {
      expect(customModelOption("gpt 5 mini", azureSample)).toBeNull();
      expect(customModelOption("   ", azureSample)).toBeNull();
    });

    it("never offers a bare id without an Azure sample to justify it", () => {
      expect(customModelOption("gpt5mini", undefined)).toBeNull();
      expect(customModelOption("gpt5mini", sample)).toBeNull();
    });
  });
});
