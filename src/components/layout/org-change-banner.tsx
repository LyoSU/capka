"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Settings2, X } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";

// Remembers the change (by timestamp) this admin dismissed, so the banner stays
// hidden for that change but returns when a newer platform-wide change is made.
const DISMISS_KEY = "capka:dismissed-org-change";

type Notice = { at: number; actor: string; title: string; value: string };

/**
 * Admin-only strip shown when ANOTHER admin changed a platform-wide setting —
 * so shared config changes aren't silent. One cheap call on mount (no polling);
 * the server never shows an admin their own change. Renders nothing for
 * non-admins, when there's no recent change, or once this change is dismissed.
 */
export function OrgChangeBanner() {
  const isAdmin = useIsAdmin();
  const t = useTranslations("orgChangeBanner");
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch("/api/admin/org-change")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.notice) return;
        if (localStorage.getItem(DISMISS_KEY) === String(d.notice.at)) return;
        setNotice(d.notice);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin || !notice) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(notice.at));
    setNotice(null);
  };

  return (
    <div className="relative flex items-center justify-center gap-2 border-b border-border bg-muted/40 px-10 py-2 text-sm text-foreground">
      <Settings2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("message", { actor: notice.actor, title: notice.title, value: notice.value })}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismiss")}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-opacity hover:opacity-70"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
