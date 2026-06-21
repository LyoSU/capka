"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

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

  if (!status || status.source === "none") return null;

  const envLine = `UNCLAW_MASTER_KEY=${status.key ?? ""}`;

  async function copyEnv() {
    try {
      await navigator.clipboard.writeText(envLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(tc("error"));
    }
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
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{t("insecureTitle")}</p>
            <p className="text-sm text-amber-800/80 dark:text-amber-300/80">{t("insecureBody")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
            {envLine}
          </code>
          <Button variant="outline" size="sm" onClick={copyEnv}>
            {copied ? <Check className="text-emerald-600" /> : <Copy />}
            {copied ? tc("copied") : tc("copy")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("restartHint")}</p>
      </div>
    );
  }

  // Secure via env, but a stale DB copy remains — offer to finish the cleanup.
  if (status.dbKeyPresent) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500" />
          <p className="text-sm text-amber-800/90 dark:text-amber-300/90">{t("secureLeftover")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={removeDbCopy} disabled={removing}>
          {t("removeDbCopy")}
        </Button>
      </div>
    );
  }

  // Fully secure.
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
      {t("secureClean")}
    </div>
  );
}
