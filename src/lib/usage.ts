import { nanoid } from "nanoid";
import { db } from "./db";
import { usage } from "./db/schema";
import { costUsd as resolveCost, type TokenUsage } from "./pricing";
import { log } from "./log";

export interface RecordUsageInput {
  taskId?: string | null;
  messageId?: string | null;
  userId: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  /** True when this spend hit the shared (admin) key — counts toward budgets. */
  onSharedKey?: boolean;
  /** Pre-computed cost from the caller. When omitted, cost is resolved from the
   *  catalog here. Lets the runner pass the figure it already computed for the
   *  message metadata instead of paying for a second catalog lookup. */
  costUsd?: number | null;
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
      model: input.model,
      inputTokens: input.usage.inputTokens ?? 0,
      outputTokens: input.usage.outputTokens ?? 0,
      cachedInputTokens: input.usage.cachedInputTokens ?? 0,
      costUsd: cost === null ? null : String(cost),
      onSharedKey: input.onSharedKey ?? false,
    });
  } catch (err) {
    log.error("usage record failed (non-fatal)", { err: String(err) });
  }
}
