"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { TopBanner } from "./top-banner";

// Remembers the state the admin dismissed (e.g. "out_of_credits"), keyed by the
// state itself so a different problem still surfaces. Cleared once the account is
// healthy again, so the same problem recurring re-shows the banner.
const DISMISS_KEY = "capka:dismissed-provider-status";

/**
 * Admin-only deployment health strip. Polls /api/admin/status (which reflects
 * the shared key's live state) and shows a calm, actionable bar when the AI is
 * blocked account-side. Renders nothing for non-admins or when healthy, so it
 * adds no layout cost in the normal case.
 */
export function ProviderStatusBanner() {
  const isAdmin = useIsAdmin();
  const t = useTranslations("providerStatus");
  const [status, setStatus] = useState("ok");
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const check = () =>
      fetch("/api/admin/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d?.status) return;
          setStatus(d.status);
          if (d.status === "ok") localStorage.removeItem(DISMISS_KEY);
          setDismissed(localStorage.getItem(DISMISS_KEY));
        })
        .catch(() => {});
    check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAdmin]);

  if (!isAdmin || status === "ok" || dismissed === status) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, status);
    setDismissed(status);
  };

  const message = status === "out_of_credits" ? t("outOfCredits") : t("invalidKey");
  return (
    <TopBanner
      icon={<AlertTriangle className="h-4 w-4 shrink-0 text-warning-text" />}
      action={{ href: "/settings/connections", label: t("fix") }}
      onDismiss={dismiss}
      dismissLabel={t("dismiss")}
    >
      {message}
    </TopBanner>
  );
}
