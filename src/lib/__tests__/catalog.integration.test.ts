import { describe, it, expect } from "vitest";
import { syncModelCatalog, getModelPrice } from "../models/catalog";
import { db } from "../db";
import { models } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { costUsd } from "../pricing";

// Hits the real network (OpenRouter + LiteLLM) and a live dev DB. Opt-in only:
//   RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run _catalog.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

run("catalog integration (real network + dev DB)", () => {
  it("syncs and populates a curated, priced catalog", async () => {
    const res = await syncModelCatalog();
    expect(res.openrouter).toBeGreaterThan(50);

    const total = (await db.select().from(models)).length;
    const enabled = (await db.select().from(models).where(eq(models.enabled, true))).length;
    expect(total).toBeGreaterThan(100);
    expect(enabled).toBeGreaterThan(10);

    const price = await getModelPrice("anthropic/claude-opus-4.1");
    expect(price?.input).toBeGreaterThan(0);
    const cost = await costUsd("anthropic/claude-opus-4.1", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeGreaterThan(0);

    const { isNotNull } = await import("drizzle-orm");
    const enriched = await db.select().from(models).where(isNotNull(models.cutoff));
    expect(enriched.length).toBeGreaterThan(0);
  }, 180_000);

  it("refreshes an existing LiteLLM row's capabilities on resync", async () => {
    // A LiteLLM row synced before the parser learned per-model input modalities
    // (or before the price book listed them) is frozen without `input`. Force
    // that stale state, then resync: the row MUST regain its modalities. With the
    // old onConflictDoNothing this stayed stale forever — the bug behind
    // "model doesn't support audio" for gemini through a LiteLLM gateway.
    await db
      .insert(models)
      .values({
        id: "gemini-3.5-flash",
        source: "litellm",
        displayName: "Gemini 3.5 Flash",
        group: "Google",
        icon: "google",
        contextLength: 1048576,
        capabilities: { vision: true, tools: true, reasoning: true }, // no `input`
        enabled: false,
      })
      .onConflictDoUpdate({
        target: models.id,
        set: { source: sql`'litellm'`, capabilities: sql`'{"vision":true,"tools":true,"reasoning":true}'::jsonb` },
      });

    await syncModelCatalog();

    const [row] = await db.select().from(models).where(eq(models.id, "gemini-3.5-flash"));
    const input = (row?.capabilities as { input?: string[] } | null)?.input ?? [];
    expect(input).toContain("audio");
  }, 180_000);
});
