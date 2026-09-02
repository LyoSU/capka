"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { SettingsGroup, SettingsSection } from "@/components/settings/shell";
import { Skeleton } from "@/components/ui/skeleton";

interface SecurityStatus {
  source: "env" | "db" | "none";
  dbKeyPresent: boolean;
  key: string | null;
}

/**
 * Admin-only master-key posture. The master key both encrypts provider API keys
 * and signs sessions, so the safe migration is to move the SAME value to the env
 * (never a new one). Three states: insecure (DB-stored, offer copy-to-env),
 * secure-with-leftover (env set but stale DB copy, offer cleanup), fully secure.
 */
export function MasterKeyBanner() {
  const t = useTranslations("settings.security.masterKey");
  const ts = useTranslations("settings.security");
  const tc = useTranslations("common");
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    fetch("/api/admin/security")
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => {});
  }, []);

  // Owns its section heading, so the heading appears only with a body under it.
  // `none` (no key configured at all) has nothing to say and says nothing.
  if (status?.source === "none") return null;
  const section = (body: React.ReactNode) => (
    <SettingsSection title={ts("encryptionKey")} description={ts("encryptionKeyDesc")}>
      {body}
    </SettingsSection>
  );
  if (!status) {
    return section(
      <SettingsGroup>
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-4 w-56 rounded" />
        </div>
      </SettingsGroup>,
    );
  }

  const envLine = `CAPKA_MASTER_KEY=${status.key ?? ""}`;

  async function copyEnv() {
    if (!(await copyToClipboard(envLine))) {
      toast.error(tc("error"));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function removeDbCopy() {
    setRemoving(true);
    try {
      const res = await fetch("/api/admin/security", { method: "DELETE" });
      if (res.ok) {
        toast.success(t("removed"));
        setStatus({ ...status!, dbKeyPresent: false });
      } else {
        toast.error(t("removeFailed"));
      }
    } catch {
      toast.error(t("removeFailed"));
    } finally {
      setRemoving(false);
    }
  }

  // Insecure: master key lives in the DB. Offer to promote it to the env.
  if (status.source === "db") {
    return section(
      <div className="space-y-3 rounded-xl border border-warning-border bg-warning-surface p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning-text" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{t("insecureTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("insecureBody")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
            {envLine}
          </code>
          <Button variant="outline" size="sm" onClick={copyEnv}>
            {copied ? <Check className="text-success" /> : <Copy />}
            {copied ? tc("copied") : tc("copy")}
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground">{t("restartHint")}</p>
      </div>,
    );
  }

  // Secure via env, but a stale DB copy remains — offer to finish the cleanup.
  if (status.dbKeyPresent) {
    return section(
      <div className="flex items-center justify-between gap-3 rounded-xl border border-warning-border bg-warning-surface p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning-text" />
          <p className="text-sm text-foreground">{t("secureLeftover")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={removeDbCopy} disabled={removing}>
          {t("removeDbCopy")}
        </Button>
      </div>,
    );
  }

  // Fully secure: one row in the same card grammar as every other setting, so
  // "all is well" looks like a state and not like a footnote.
  return section(
    <SettingsGroup>
      <div className="flex items-center gap-2.5 px-4 py-3.5 text-sm">
        <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
        {t("secureClean")}
      </div>
    </SettingsGroup>,
  );
}
