"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpCircle, Check, CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/chat/markdown";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSetting } from "@/hooks/use-setting";

interface UpdateStatus {
  enabled: boolean;
  current: string;
  sha: string | null;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  error: string | null;
}

// The host command that pulls the new images and recreates the stack. Capka has
// no host access from inside its container (the sandbox boundary), so updating is
// deliberately a host action — we show the exact command rather than pretend to
// do it from the browser.
const UPDATE_CMD = "cd /opt/capka && sudo ./scripts/update.sh";

export default function UpdatesSettingsPage() {
  const isAdmin = useIsAdmin();
  const t = useTranslations("settings.updates");
  const check = useSetting("update_check_enabled", "true");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/updates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAdmin]);

  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(UPDATE_CMD);
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const toggleCheck = (checked: boolean) => {
    const prev = check.value;
    const next = checked ? "true" : "false";
    check.update(next);
    check.persist(next)
      .then((ok) => {
        if (ok) toast.success(checked ? t("checkEnabled") : t("checkDisabled"));
        else { check.setValue(prev); toast.error(t("updateFailed")); }
      })
      .catch(() => { check.setValue(prev); toast.error(t("updateFailed")); });
  };

  const isDev = !status || status.current === "dev" || !/^v?\d/.test(status.current);
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {/* Version state */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("running")}</p>
            <p className="font-mono text-sm text-muted-foreground">
              {isDev ? t("devBuild") : status!.current}
              {status?.sha ? <span className="ml-1.5 opacity-60">({status.sha.slice(0, 7)})</span> : null}
            </p>
          </div>
          {status?.updateAvailable ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning-surface px-2.5 py-1 text-xs font-medium text-warning-text">
              <ArrowUpCircle className="h-3.5 w-3.5" />
              {t("updateAvailable", { version: status.latest! })}
            </span>
          ) : status && !status.enabled ? (
            <span className="shrink-0 text-xs text-muted-foreground">{t("checksOff")}</span>
          ) : status?.error ? (
            <span className="shrink-0 text-xs text-muted-foreground">{t("checkFailed")}</span>
          ) : status?.latest ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("upToDate")}
            </span>
          ) : null}
        </div>

        {/* Release details when an update exists */}
        {status?.updateAvailable && (
          <div className="mt-3 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{status.releaseName || status.latest}</p>
              {status.publishedAt && (
                <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(status.publishedAt)}</span>
              )}
            </div>
            {status.notes && (
              <div className="chat-prose mt-2 max-h-48 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                <Markdown>{status.notes}</Markdown>
              </div>
            )}
            {status.releaseUrl && (
              <a
                href={status.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {t("viewChangelog")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>

      {/* How to update */}
      <div>
        <h3 className="text-sm font-medium">{t("howTo")}</h3>
        <p className="text-sm text-muted-foreground">{t("howToHint")}</p>
        <div className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/30 p-2 pl-3">
          <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">{UPDATE_CMD}</code>
          <button
            type="button"
            onClick={copy}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
      </div>

      <Separator />

      {/* Auto-check toggle */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="pr-4">
          <p className="text-sm font-medium">{t("autoCheck")}</p>
          <p className="text-xs text-muted-foreground">{t("autoCheckHint")}</p>
        </div>
        <Switch checked={check.value !== "false"} onCheckedChange={toggleCheck} />
      </div>
    </div>
  );
}
