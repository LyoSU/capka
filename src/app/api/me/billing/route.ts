import { requireSession, apiHandler } from "@/lib/auth";
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

  return Response.json({ keyMode, ownKeysAllowed: canAddOwn, onSharedKey, limits });
});
