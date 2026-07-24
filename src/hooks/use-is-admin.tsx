"use client";

import { createContext, useContext } from "react";

/**
 * Admin flag for role-gated UI, resolved SERVER-side.
 *
 * The dashboard layout already loads the session to enforce the pending/suspended
 * gates, so the role is free there — it rides down as context instead of being
 * re-derived over HTTP. That matters beyond the saved round-trip: the previous
 * version probed `/api/admin/users` and read `res.ok` as "am I an admin", which
 * ran the full user-listing query (usage aggregation included) just to learn one
 * boolean, silently degraded to "not admin" on any 500/network blip, and cached
 * the answer in a module variable that no logout or role change ever invalidated.
 *
 * Defaults to `false` outside the provider — the root error boundary
 * (`src/app/error.tsx`) renders above the dashboard layout, so it has no session
 * context to read and must fall back to the non-admin view.
 */
const IsAdminContext = createContext(false);

/** Server-rendered in `(dashboard)/layout.tsx`; `value` is the session's role check. */
export const IsAdminProvider = IsAdminContext.Provider;

export function useIsAdmin(): boolean {
  return useContext(IsAdminContext);
}
