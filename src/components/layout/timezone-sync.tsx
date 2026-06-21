"use client";

import { useEffect } from "react";

/**
 * Silently keeps `user.timezone` in sync with the browser's IANA timezone.
 *
 * No UI: the user never picks a zone manually — we read it from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` and push it once. The
 * agent reads it back per-run to localize the conversation's start date.
 *
 * We remember the last value we sent in `localStorage` so a returning user
 * who hasn't travelled doesn't re-hit the API on every page load; we only PUT
 * when the detected zone actually differs.
 */
export function TimezoneSync() {
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    if (localStorage.getItem("tz") === tz) return;

    fetch("/api/settings/timezone", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: tz }),
    })
      .then((res) => {
        if (res.ok) localStorage.setItem("tz", tz);
      })
      .catch(() => {
        /* offline / transient — next load retries */
      });
  }, []);

  return null;
}
