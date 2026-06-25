"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";

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

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const check = () =>
      fetch("/api/admin/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d?.status) setStatus(d.status);
        })
        .catch(() => {});
    check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAdmin]);

  if (!isAdmin || status === "ok") return null;

  const message = status === "out_of_credits" ? t("outOfCredits") : t("invalidKey");
  return (
    <div className="flex items-center justify-center gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-sm text-foreground">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning-text" />
      <span>{message}</span>
      <Link
        href="/settings/connections"
        className="shrink-0 font-medium text-warning-text underline underline-offset-2 hover:opacity-80"
      >
        {t("fix")}
      </Link>
    </div>
  );
}
