import { describe, it, expect, vi, beforeEach } from "vitest";

// The `/model` menu reads recent chat models from the DB and the set of configs
// the user may draw on. Only those two inputs are stubbed — ref encoding,
// modality icons, and name prettifying stay real, so a label regression fails here.
const h = vi.hoisted(() => {
  let recent: { model: string | null }[] = [];
  return {
    setRecent: (models: (string | null)[]) => { recent = models.map((model) => ({ model })); },
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(recent) }),
          }),
        }),
      }),
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

const { resolveEnabledConfigs } = vi.hoisted(() => ({ resolveEnabledConfigs: vi.fn() }));
vi.mock("@/lib/providers/resolve", () => ({ resolveEnabledConfigs }));

// OpenRouter is the only provider whose modalities come from a live catalog.
const { getModelInputModalities } = vi.hoisted(() => ({ getModelInputModalities: vi.fn() }));
vi.mock("@/lib/providers/list-models", () => ({ getModelInputModalities }));

import { modelChoices } from "@/lib/telegram/model-menu";

const config = (over: Record<string, unknown> = {}) => ({
  id: "cfg-admin",
  userId: "admin-1",
  provider: "anthropic",
  defaultModel: "claude-sonnet-5",
  isShared: true,
  ...over,
});

beforeEach(() => {
  h.setRecent([]);
  resolveEnabledConfigs.mockReset();
  getModelInputModalities.mockReset();
  getModelInputModalities.mockResolvedValue(null);
});

describe("modelChoices", () => {
  it("offers a SHARED admin config to a user who owns no configs", async () => {
    // The regression this guards: the menu used to query provider_configs by
    // userId directly, so on an instance where one admin key is shared with the
    // org, every non-admin got an empty list ("No models available yet") while
    // the web picker — which resolves the shared pool — showed the same models.
    resolveEnabledConfigs.mockResolvedValue([config()]);

    const choices = await modelChoices("member-1");

    expect(resolveEnabledConfigs).toHaveBeenCalledWith("member-1");
    expect(choices).toHaveLength(1);
    expect(choices[0].ref).toBe("cfg-admin:claude-sonnet-5");
    expect(choices[0].label).toContain("Claude Sonnet 5");
  });

  it("puts recently used models before config defaults and dedupes them", async () => {
    h.setRecent(["cfg-admin:claude-opus-4-8", "cfg-admin:claude-opus-4-8"]);
    resolveEnabledConfigs.mockResolvedValue([config()]);

    const choices = await modelChoices("member-1");

    expect(choices.map((c) => c.ref)).toEqual([
      "cfg-admin:claude-opus-4-8",
      "cfg-admin:claude-sonnet-5",
    ]);
  });

  it("returns nothing when no config is reachable and no chat has a model", async () => {
    resolveEnabledConfigs.mockResolvedValue([]);

    expect(await modelChoices("member-1")).toEqual([]);
  });

  it("caps the list so the keyboard stays inside Telegram's limits", async () => {
    h.setRecent(Array.from({ length: 12 }, (_, i) => `cfg-admin:model-${i}`));
    resolveEnabledConfigs.mockResolvedValue([config()]);

    expect(await modelChoices("member-1")).toHaveLength(8);
  });

  it("tags an OpenRouter model with the modalities its catalog reports", async () => {
    resolveEnabledConfigs.mockResolvedValue([
      config({ id: "cfg-or", provider: "openrouter", defaultModel: "google/gemini-3-pro" }),
    ]);
    getModelInputModalities.mockResolvedValue(["image", "audio"]);

    const [choice] = await modelChoices("member-1");

    expect(choice.label).toContain("🖼");
    expect(choice.label).toContain("🎧");
  });
});
