"use client";

import { useEffect, useState } from "react";

export type WindowKey = "h5" | "d7" | "d30";

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
}

// Cached across remounts (the dashboard's keyed <ViewTransition> remounts the
// route subtree on every navigation). `undefined` = not yet loaded, distinct
// from a valid `null` result; `inflight` dedups concurrent first-mount fetches.
let cached: BillingInfo | null | undefined;
let inflight: Promise<BillingInfo | null> | undefined;

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
    inflight ??= fetch("/api/me/billing")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    inflight.then((d) => {
      cached = d;
      setData(d);
      setLoading(false);
    });
  }, []);

  return { billing: data, loading };
}
