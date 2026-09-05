import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./db";
import { usage } from "./db/schema";
import { costUsd as resolveCost, type TokenUsage } from "./pricing";
import type { LlmPurpose } from "./chat/contracts";
import { log } from "./log";

export interface RecordUsageInput {
  taskId?: string | null;
  messageId?: string | null;
  userId: string;
  provider: string;
  /** The provider CONNECTION this spend went through — null when unknown. */
  configId?: string | null;
  model: string;
  usage: TokenUsage;
  /** True when this spend hit the shared (admin) key — counts toward budgets. */
  onSharedKey?: boolean;
  /** Pre-computed cost from the caller. When omitted, cost is resolved from the
   *  catalog here. Lets the runner pass the figure it already computed for the
   *  message metadata instead of paying for a second catalog lookup. */
  costUsd?: number | null;
  /** WHAT this call bought — the reply, or one of the background passes a finished
   *  turn spawns. Optional at the type level only so the pre-turn budget hold (which
   *  reserves before anything is known) can omit it; every settled row names one. */
  purpose?: LlmPurpose;
}

/**
 * Persist a single usage row with computed cost. Never throws: usage capture
 * is observability, so a failure here must not break the task that produced it.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    const cost = input.costUsd !== undefined ? input.costUsd : await resolveCost(input.model, input.usage);
    await db.insert(usage).values({
      id: nanoid(),
      taskId: input.taskId ?? null,
      messageId: input.messageId ?? null,
      userId: input.userId,
      provider: input.provider,
      configId: input.configId ?? null,
      model: input.model,
      // Cache WRITES are input tokens billed at their own (higher) rate: `cost`
      // above already priced them separately, so folding them into the stored
      // input count here keeps the ledger's token totals complete without
      // charging them twice. Only cache READS stay in their own column.
      inputTokens: (input.usage.inputTokens ?? 0) + (input.usage.cacheWriteTokens ?? 0),
      outputTokens: input.usage.outputTokens ?? 0,
      cachedInputTokens: input.usage.cachedInputTokens ?? 0,
      costUsd: cost === null ? null : String(cost),
      onSharedKey: input.onSharedKey ?? false,
      purpose: input.purpose ?? null,
    });
  } catch (err) {
    log.error("usage record failed (non-fatal)", { err: String(err) });
  }
}

/**
 * Settle a turn's pre-reserved budget hold to the REAL figures: update the
 * pending row (written by reserveBudget at the gate) in place to the actual
 * cost/tokens and clear `pending`. Falls back to a plain insert when no hold
 * exists (own-key turns, or a hold that was released) so analytics stay complete.
 * Like recordUsage, never throws — the spend ledger is best-effort.
 */
export async function reconcileUsage(input: RecordUsageInput): Promise<void> {
  // Settling a hold means settling the REPLY's spend — the background passes have no
  // hold and bill through recordUsage directly. Normalized once, up front, so the
  // no-hold fallback below records the same purpose the update branch would have.
  const settled: RecordUsageInput = { ...input, purpose: input.purpose ?? "turn" };
  if (!settled.taskId) return void (await recordUsage(settled));
  try {
    const cost = settled.costUsd !== undefined ? settled.costUsd : await resolveCost(settled.model, settled.usage);
    const updated = await db
      .update(usage)
      .set({
        provider: settled.provider,
        configId: settled.configId ?? null,
        model: settled.model,
        // Same fold as recordUsage: cache writes count as input tokens here, and
        // were already priced at their own rate in `cost`.
        inputTokens: (settled.usage.inputTokens ?? 0) + (settled.usage.cacheWriteTokens ?? 0),
        outputTokens: settled.usage.outputTokens ?? 0,
        cachedInputTokens: settled.usage.cachedInputTokens ?? 0,
        costUsd: cost === null ? null : String(cost),
        onSharedKey: settled.onSharedKey ?? false,
        // The hold was reserved before the turn ran and named no purpose; settling it
        // is where the row learns it paid for the reply rather than for housekeeping.
        purpose: settled.purpose,
        pending: false,
      })
      .where(and(eq(usage.taskId, settled.taskId), eq(usage.pending, true)))
      .returning({ id: usage.id });
    // No hold to settle (own-key, or it was released) — record the spend fresh.
    if (updated.length === 0) await recordUsage(settled);
  } catch (err) {
    log.error("usage reconcile failed (non-fatal)", { err: String(err) });
  }
}
