import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getAuth } from "@/lib/auth";
import { isSetupComplete } from "@/lib/settings";

/** The first-run wizard advances through these, in order. */
export const SETUP_STEPS = ["account", "provider", "telegram"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Pure: where the wizard should resume given the progress we observe on the
 * server. The account is created the moment a session exists (better-auth sets
 * the cookie on sign-up), so a signed-in visitor has already cleared step 1 —
 * re-showing it would only dead-end on a duplicate sign-up.
 */
export function resumeStep(o: { hasSession: boolean; hasProviderConfig: boolean }): SetupStep {
  if (!o.hasSession) return "account";
  return o.hasProviderConfig ? "telegram" : "provider";
}

/**
 * The single source of truth for setup progress. Reads real state — completion
 * flag, session, saved provider config — so a page refresh resumes exactly
 * where the admin left off instead of restarting at account creation.
 */
export async function getSetupState(): Promise<{
  complete: boolean;
  signedIn: boolean;
  step: SetupStep;
}> {
  if (await isSetupComplete()) {
    return { complete: true, signedIn: false, step: "account" };
  }

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { complete: false, signedIn: false, step: "account" };
  }

  const [cfg] = await db
    .select({ id: providerConfigs.id })
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, session.user.id), eq(providerConfigs.isActive, true)))
    .limit(1);

  return {
    complete: false,
    signedIn: true,
    step: resumeStep({ hasSession: true, hasProviderConfig: !!cfg }),
  };
}
