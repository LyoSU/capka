"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  SettingsPage,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSkeleton,
  SettingsEmpty,
} from "@/components/settings/shell";
import { ArrowUpCircle, Check, CheckCircle2, Copy, ExternalLink, Lock } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSetting } from "@/hooks/use-setting";
import { copyToClipboard } from "@/lib/clipboard";

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
    return (
      <SettingsPage title={t("title")} description={t("subtitle")}>
        <SettingsEmpty icon={Lock} title={t("adminOnly")} hint={t("adminOnlyHint")} />
      </SettingsPage>
    );
  }

  if (loading) return <SettingsSkeleton />;

  const copy = async () => {
    if (!(await copyToClipboard(UPDATE_CMD))) {
      toast.error(t("copyFailed"));
      return;
    }
    setCopied(true);
    toast.success(t("copied"));
    setTimeout(() => setCopied(false), 2000);
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
    <SettingsPage title={t("title")} description={t("subtitle")}>
      {/* Version state — a row in the same card grammar as every other setting.
          The version is a name, not code: mono only for the real tag and its
          short sha, never for the "development build" sentence. */}
      <SettingsGroup>
        <div className="py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <p className="text-[15px]">{t("running")}</p>
            <p className={isDev ? "text-[13px] text-muted-foreground" : "font-mono text-[13px] text-muted-foreground"}>
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
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-success">
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
              <div className="chat-prose mt-2 max-h-48 overflow-y-auto rounded-lg bg-field p-3 text-[13px] text-muted-foreground">
                <Markdown>{status.notes}</Markdown>
              </div>
            )}
            {status.releaseUrl && (
              <a
                href={status.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium underline-offset-4 hover:underline"
              >
                {t("viewChangelog")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
        </div>
      </SettingsGroup>

      {/* How to update */}
      <SettingsSection title={t("howTo")} description={t("howToHint")}>
        <div className="flex items-center gap-2 rounded-xl bg-field p-1.5 pl-3.5 shadow-hairline">
          <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px]">{UPDATE_CMD}</code>
          <Button variant="ghost" size="sm" onClick={copy} className="shrink-0 text-muted-foreground">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      </SettingsSection>

      {/* Auto-check toggle */}
      <SettingsGroup>
        <SettingsRow
          title={t("autoCheck")}
          hint={t("autoCheckHint")}
          control={<Switch checked={check.value !== "false"} onCheckedChange={toggleCheck} />}
          onLabelClick={() => toggleCheck(check.value === "false")}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
