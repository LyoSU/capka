import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { recordUsage } from "@/lib/usage";
import { log } from "@/lib/log";
import type { AuxRecord } from "@/lib/chat/contracts";
import type { TokenUsage } from "@/lib/pricing";
import { costUsd as resolveCost } from "@/lib/pricing";

/**
 * Bill a background call and make it VISIBLE on the turn it belongs to.
 *
 * Two writes, because they answer two different questions. The `usage` row is the
 * money ledger — it already existed for these calls, just without saying what they
 * bought (see `purpose`). The `metadata.aux` entry is the UI's: the (i) popover
 * shows a turn's own row, and a JOIN against the ledger to explain "why three
 * requests" would be a second query on every message render.
 *
 * NOT a plain read-modify-write of the metadata. `title`, `memory` and `compaction`
 * are dispatched TOGETHER as three unawaited promises (runner.ts), so a JS-side
 * read-then-write would have two of them read the same array and the last writer
 * would drop the others' entries. The concatenation happens inside Postgres, where
 * the row lock serializes the three appends for us.
 *
 * Never throws: it runs after the reply was delivered, and losing the accounting for
 * a background call must not turn a finished turn into a failed one.
 */
export async function recordAuxSpend(input: {
  taskId: string;
  messageId: string;
  userId: string;
  provider: string;
  configId?: string | null;
  model: string;
  onSharedKey: boolean;
  purpose: AuxRecord["purpose"];
  usage: TokenUsage;
  /** The model the CONVERSATION ran on. When the background call used a different
   *  one (the admin pointed housekeeping at a cheaper model), the popover says so;
   *  when they match, the entry omits it and the popover stays quiet. */
  turnModel: string;
}): Promise<void> {
  // Priced once, here, and handed to both writes — the ledger would otherwise pay
  // for a second catalog lookup to reach the same number.
  const cost = await resolveCost(input.model, input.usage).catch(() => null);

  await recordUsage({
    taskId: input.taskId,
    messageId: input.messageId,
    userId: input.userId,
    provider: input.provider,
    configId: input.configId,
    model: input.model,
    onSharedKey: input.onSharedKey,
    purpose: input.purpose,
    usage: input.usage,
    costUsd: cost,
  });

  const entry: AuxRecord = {
    purpose: input.purpose,
    // Cache writes fold into input for display, exactly as the ledger folds them:
    // they are input tokens, just billed at their own rate.
    input: (input.usage.inputTokens ?? 0) + (input.usage.cacheWriteTokens ?? 0),
    output: input.usage.outputTokens ?? 0,
    ...((input.usage.cachedInputTokens ?? 0) > 0 ? { cached: input.usage.cachedInputTokens } : {}),
    ...(cost != null ? { costUsd: cost } : {}),
    ...(input.model !== input.turnModel ? { model: input.model } : {}),
  };

  try {
    await db.execute(sql`
      UPDATE messages
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{aux}',
        COALESCE(metadata->'aux', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb,
        true
      )
      WHERE id = ${input.messageId}
    `);
  } catch (err) {
    log.warn("could not attach background-call accounting to the message", {
      messageId: input.messageId, purpose: input.purpose, err: String(err),
    });
  }
}
