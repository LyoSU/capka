import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSetting, isSetupComplete } from "@/lib/settings";
import { resumeStep, type SetupStep } from "@/lib/setup-steps";

// Client-safe primitives (SETUP_STEPS, SetupStep, resumeStep) live in
// ./setup-steps so client components can import them without pulling this
// module's server-only deps (db/pg → node `tls`) into the browser bundle.
export { SETUP_STEPS, resumeStep, type SetupStep } from "@/lib/setup-steps";

/**
 * The single source of truth for setup progress. Reads real state — completion
 * flag and session — so a page refresh resumes exactly where the admin left
 * off instead of restarting at account creation.
 */
export async function getSetupState(): Promise<{
  complete: boolean;
  signedIn: boolean;
  step: SetupStep;
  /** Whether a SETUP_TOKEN is configured (advanced, opt-in hardening). When unset
   *  the wizard shows no token step at all — first-run stays zero-friction. */
  setupTokenRequired: boolean;
}> {
  const setupTokenRequired = !!process.env.SETUP_TOKEN?.trim();
  if (await isSetupComplete()) {
    return { complete: true, signedIn: false, step: "account", setupTokenRequired };
  }

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { complete: false, signedIn: false, step: "account", setupTokenRequired };
  }

  // Admin is claimed when admin_email matches this session — only then is the
  // account step truly done. Otherwise resume there so the operator can submit
  // the SETUP_TOKEN (a refresh after sign-up but before the token must not skip
  // the claim and dead-end on the provider step).
  const adminEmail = await getSetting("admin_email");
  const adminClaimed = !!adminEmail && adminEmail === session.user.email;
  return {
    complete: false,
    signedIn: true,
    step: resumeStep({ hasSession: true, adminClaimed }),
    setupTokenRequired,
  };
}
