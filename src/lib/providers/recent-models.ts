import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { encodeModelRef } from "./registry";

/** How far back a model still counts as "recently used". */
const WINDOW_DAYS = 30;
/** Enough to be worth a tab, short enough to scan without scrolling. */
const DEFAULT_LIMIT = 8;

/**
 * The models this user actually ran turns on, most-recent first, as the picker's
 * config-scoped refs.
 *
 * Sourced from the spend ledger rather than from `chats.model`, which is what the
 * Telegram `/model` menu uses: a chat row records the model the CONVERSATION is
 * set to, so a chat of forty turns and a chat holding one "hi" weigh the same,
 * and a model switched to but never sent on ranks as if it had been used.
 *
 * `purpose = 'turn'` is load-bearing twice over. Background passes (chat titles,
 * memory extraction, compaction) may run on their own cheaper `aux_model`, which
 * the user never picked and must never be offered back to them as "recent". And
 * a pending budget hold is written before a turn runs with no purpose at all, so
 * the same filter keeps an in-flight — possibly failing — turn out of the list
 * until it has settled. Rows written before `usage.purpose` existed are
 * unattributed by design and simply do not appear.
 */
export async function recentModelRefs(userId: string, limit = DEFAULT_LIMIT): Promise<string[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Grouped by (model, config) — not by model alone. The same model id can be
  // served by two enabled connections, and the picker selects by the ref that
  // pairs them, so collapsing them here would point "recent" at whichever
  // connection happened to sort first.
  const rows = await db
    .select({ model: usage.model, configId: usage.configId })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.purpose, "turn"), gt(usage.createdAt, since)))
    .groupBy(usage.model, usage.configId)
    .orderBy(sql`max(${usage.createdAt}) desc`)
    .limit(limit);

  return rows.map((r) => (r.configId ? encodeModelRef(r.configId, r.model) : r.model));
}
