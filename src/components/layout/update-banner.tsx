"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpCircle } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { TopBanner } from "./top-banner";

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
    <TopBanner
      icon={<ArrowUpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />}
      action={{ href: "/settings/updates", label: t("action") }}
      onDismiss={dismiss}
      dismissLabel={t("dismiss")}
    >
      {t("message", { version: latest })}
    </TopBanner>
  );
}
