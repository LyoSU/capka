import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSetting, isSetupComplete } from "@/lib/settings";
import { resumeStep, type SetupStep } from "@/lib/setup-steps";

// Client-safe primitives (SETUP_STEPS, SetupStep, resumeStep) live in
// ./setup-steps so client components can import them without pulling this
// module's server-only deps (db/pg → node `tls`) into the browser bundle.
export { SETUP_STEPS, resumeStep, type SetupStep } from "@/lib/setup-steps";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * Whether this deployment is reachable from beyond the host, decided from SERVER
 * configuration ONLY — never from request headers. A gate keyed on Host or
 * X-Forwarded-Host is defeated by `curl -H "Host: localhost"`, i.e. by exactly the
 * actor it exists to stop.
 *
 * Compose always passes PLATFORM_BIND (defaulting to the same 0.0.0.0 its port
 * mapping uses), so an ABSENT value means a bare `npm run dev` / `npm start` on a
 * developer machine — the frictionless case. An unparseable PUBLIC_URL counts as
 * exposed: a malformed override must never silently unlock the bootstrap.
 */
export function isPubliclyReachable(env: Record<string, string | undefined> = process.env): boolean {
  const publicUrl = (env.PUBLIC_URL || env.BETTER_AUTH_URL || "").trim();
  if (publicUrl) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(publicUrl).hostname.toLowerCase())) return true;
    } catch {
      return true;
    }
  }
  const bind = env.PLATFORM_BIND?.trim();
  return !!bind && !LOOPBACK_HOSTS.has(bind.toLowerCase());
}

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
  /** True when this deploy is reachable from the network AND no SETUP_TOKEN is
   *  configured — first-run is refused rather than raced for admin. */
  bootstrapBlocked: boolean;
}> {
  const setupTokenRequired = !!process.env.SETUP_TOKEN?.trim();
  const bootstrapBlocked = !setupTokenRequired && isPubliclyReachable();
  if (await isSetupComplete()) {
    return { complete: true, signedIn: false, step: "account", setupTokenRequired, bootstrapBlocked: false };
  }

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { complete: false, signedIn: false, step: "account", setupTokenRequired, bootstrapBlocked };
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
    bootstrapBlocked,
  };
}
