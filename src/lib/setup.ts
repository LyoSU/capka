import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getAuth } from "@/lib/auth";
import { isSetupComplete } from "@/lib/settings";
import { resumeStep, type SetupStep } from "@/lib/setup-steps";

// Client-safe primitives (SETUP_STEPS, SetupStep, resumeStep) live in
// ./setup-steps so client components can import them without pulling this
// module's server-only deps (db/pg → node `tls`) into the browser bundle.
export { SETUP_STEPS, resumeStep, type SetupStep } from "@/lib/setup-steps";

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
