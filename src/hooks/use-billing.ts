"use client";

import { useEffect, useState } from "react";

export type WindowKey = "h5" | "d7" | "d30";

export interface WindowStatus {
  window: WindowKey;
  used: number;
  limit: number | null;
  pct: number;
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

/**
 * Per-user billing context (key mode, own-key permission, budget status). Loads
 * once from /api/me/billing. `loading` lets callers avoid flicker before the
 * mode is known (e.g. the settings nav deciding whether to show Connections).
 */
export function useBilling() {
  const [data, setData] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/me/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return { billing: data, loading };
}
