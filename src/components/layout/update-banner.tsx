"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowUpCircle, X } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";

// Remembers the version the admin dismissed. Keyed by version (not a boolean) so
// the banner stays hidden for this release but returns when a newer one ships.
const DISMISS_KEY = "capka:dismissed-update";

/**
 * Admin-only strip shown when a newer Capka release is out. Reads the same
 * cached /api/admin/updates as the settings page, so it's a single cheap call on
 * mount (no polling — releases are infrequent and the server caches for hours).
 * Renders nothing for non-admins, on the latest version, when the check is
 * off/unreachable, or once this release has been dismissed.
 */
export function UpdateBanner() {
  const isAdmin = useIsAdmin();
  const t = useTranslations("updateBanner");
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch("/api/admin/updates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.updateAvailable) return;
        if (localStorage.getItem(DISMISS_KEY) === d.latest) return;
        setLatest(d.latest);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin || !latest) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, latest);
    setLatest(null);
  };

  return (
    <div className="relative flex items-center justify-center gap-2 border-b border-warning-border bg-warning-surface px-10 py-2 text-sm text-foreground">
      <ArrowUpCircle className="h-4 w-4 shrink-0 text-warning-text" />
      <span>{t("message", { version: latest })}</span>
      <Link
        href="/settings/updates"
        className="shrink-0 font-medium text-warning-text underline underline-offset-2 hover:opacity-80"
      >
        {t("action")}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismiss")}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-warning-text transition-opacity hover:opacity-70"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
