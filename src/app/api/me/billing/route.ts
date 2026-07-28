import { and, eq, sql, countDistinct } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { getProviderKeyMode, ownKeysAllowed } from "@/lib/settings";
import { resolveProviderConfig } from "@/lib/providers/resolve";
import { getLimitStatus } from "@/lib/billing/limits";

/**
 * Per-user billing context for the dashboard: the instance key mode, whether the
 * caller may add their own key, whether they're currently spending on the shared
 * key, and their budget status (% per window). Open to any signed-in user — it
 * never exposes the admin token or another user's data.
 */
export const GET = apiHandler(async () => {
  const { userId } = await requireSession();

  const [keyMode, canAddOwn, config] = await Promise.all([
    getProviderKeyMode(),
    ownKeysAllowed(),
    resolveProviderConfig(userId),
  ]);

  const onSharedKey = config?.isShared ?? false;
  // Limits only apply to shared-key spend; skip the (cheap) query otherwise.
  const limits = onSharedKey ? await getLimitStatus(userId) : null;

  // How many turns this person has run in the last 30 days. Needed because the
  // default tier is UNLIMITED, so a normal instance has no capped window and the
  // budget widget rendered nothing at all — people reasonably read that as "my
  // usage is missing". A count answers "am I being counted?" without showing an
  // ordinary user raw money, which is an admin-only number by design.
  //
  // DISTINCT on taskId, not a row count: a turn writes one row for itself, plus one
  // more per auxiliary LLM call sharing the same taskId (memory reconcile, chat
  // title, compaction — see recordAuxUsage in tasks/runner.ts). Counting rows
  // roughly doubled the figure on the one widget whose entire job is to answer "am
  // I being counted correctly?". `pending` holds are excluded so a turn still in
  // flight isn't counted before it has happened.
  const [turns] = await db
    .select({ n: countDistinct(usage.taskId) })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.pending, false),
        sql`${usage.createdAt} >= now() - interval '30 days'`,
      ),
    );

  return Response.json({ keyMode, ownKeysAllowed: canAddOwn, onSharedKey, limits, turns30d: Number(turns?.n ?? 0) });
});
