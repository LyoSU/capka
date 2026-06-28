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
 * server. A session means the account row exists, but admin is only granted
 * once the operator proves the SETUP_TOKEN on the account step — so a signed-in
 * visitor who hasn't yet claimed admin stays on the account step (which, in
 * resume mode, asks only for the token, not a fresh sign-up). Once admin is
 * claimed the only remaining step is the provider, which also completes setup.
 */
export function resumeStep(o: { hasSession: boolean; adminClaimed: boolean }): SetupStep {
  return o.hasSession && o.adminClaimed ? "provider" : "account";
}
