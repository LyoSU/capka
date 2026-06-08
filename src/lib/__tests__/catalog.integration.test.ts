import { describe, it, expect } from "vitest";
import { syncModelCatalog, getModelPrice } from "../models/catalog";
import { db } from "../db";
import { models } from "../db/schema";
import { eq } from "drizzle-orm";
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
  }, 180_000);
});
