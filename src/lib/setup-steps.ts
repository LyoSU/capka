// Client-safe setup primitives. Kept separate from setup.ts because that
// module imports server-only code (db/auth/next-headers); importing these
// constants from there would pull `pg` (and node `tls`) into the client bundle.

// First-run is deliberately minimal: just the account and the AI provider.
// Optional integrations (Telegram, etc.) are not gates to getting started —
// they live in Settings and are configured later, once the admin is in.
/** The first-run wizard advances through these, in order. */
export const SETUP_STEPS = ["account", "provider"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Pure: where the wizard should resume given the progress we observe on the
 * server. The account is created the moment a session exists (better-auth sets
 * the cookie on sign-up), so a signed-in visitor has already cleared step 1 —
 * re-showing it would only dead-end on a duplicate sign-up. The only remaining
 * step is the provider, which also completes setup.
 */
export function resumeStep(o: { hasSession: boolean }): SetupStep {
  return o.hasSession ? "provider" : "account";
}
