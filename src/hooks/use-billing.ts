"use client";

import { useEffect, useState } from "react";

// Mirrors the server's WindowKey (src/lib/billing/limits.ts): "m1" is the
// calendar month, not a rolling 30 days.
export type WindowKey = "h5" | "d7" | "m1";

export interface WindowStatus {
  window: WindowKey;
  committed: number; // settled spend (USD)
  reserved: number; // outstanding holds (USD, estimates)
  used: number; // committed + reserved
  limit: number | null;
  pct: number; // used/limit
}

export interface BillingInfo {
  keyMode: "shared_plus_own" | "shared_only" | "own_only";
  ownKeysAllowed: boolean;
  onSharedKey: boolean;
  limits: {
    tierName: string;
    windows: WindowStatus[];
    blocked: boolean;
    blockedWindow: WindowKey | null;
  } | null;
  /** Turns run in the last 30 days. Shown when no window is capped, so the widget
   *  has something true to say instead of disappearing. */
  turns30d: number;
}

// Cached across remounts (the dashboard's keyed <ViewTransition> remounts the
// route subtree on every navigation). `undefined` = not yet loaded, distinct
// from a valid `null` result; `inflight` dedups concurrent first-mount fetches.
let cached: BillingInfo | undefined;
let inflight: Promise<BillingInfo> | undefined;

/**
 * Per-user billing context (key mode, own-key permission, budget status). Loads
 * once from /api/me/billing. `loading` lets callers avoid flicker before the
 * mode is known (e.g. the settings nav deciding whether to show Connections).
 */
export function useBilling() {
  const [data, setData] = useState<BillingInfo | null>(cached ?? null);
  const [loading, setLoading] = useState(cached === undefined);

  useEffect(() => {
    if (cached !== undefined) return;
    // A FAILED fetch must not be cached: `null` is a legitimate answer ("no
    // billing context"), so storing it on a 500/offline hid the budget widget
    // for the whole tab with no way back short of a hard reload. Failures clear
    // `inflight` instead, so the next mount (any settings navigation) retries.
    inflight ??= fetch("/api/me/billing")
      .then((r) => (r.ok ? (r.json() as Promise<BillingInfo>) : Promise.reject(new Error(String(r.status)))));
    inflight.then(
      (d) => {
        cached = d;
        setData(d);
        setLoading(false);
      },
      () => {
        inflight = undefined;
        setLoading(false);
      },
    );
  }, []);

  return { billing: data, loading };
}
