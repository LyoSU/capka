"use client";

import { useEffect, useState } from "react";

// Admin status is session-stable, but the dashboard's <RouteTransition> keys its
// <ViewTransition> by pathname, so every navigation remounts the route subtree
// (and any component using this hook). A module-level cache lets the hook
// initialize from the last known answer instead of flashing back to `false`
// until the fetch re-resolves; `inflight` dedups concurrent first-mount fetches.
let cached: boolean | undefined;
let inflight: Promise<boolean> | undefined;

export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(cached ?? false);
  useEffect(() => {
    if (cached !== undefined) return;
    inflight ??= fetch("/api/admin/users")
      .then((r) => r.ok)
      .catch(() => false);
    inflight.then((v) => {
      cached = v;
      setIsAdmin(v);
    });
  }, []);
  return isAdmin;
}
