import { nanoid } from "nanoid";
import { db } from "./db";
import { usage } from "./db/schema";
import { costUsd, type TokenUsage } from "./pricing";

export interface RecordUsageInput {
  taskId?: string | null;
  messageId?: string | null;
  userId: string;
  provider: string;
  model: string;
  usage: TokenUsage;
}

/**
 * Persist a single usage row with computed cost. Never throws: usage capture
 * is observability, so a failure here must not break the task that produced it.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    const cost = costUsd(input.model, input.usage);
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
    });
  } catch (err) {
    console.error("[usage] failed to record usage (non-fatal):", err);
  }
}
