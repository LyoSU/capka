"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Admin control: the GitHub token every marketplace fetch/install uses. Write-only,
 *  exactly like the Telegram OIDC secret — the value is encrypted at rest and never
 *  echoed back, so the UI learns only whether one is stored. A token lifts GitHub's
 *  anonymous rate limit (the usual cause of a failed install) and reaches private
 *  repos. It can't live in the conversational `manage` tool: a token pasted in chat
 *  would persist in plaintext in the transcript. */
export default function GithubTokenField() {
  const t = useTranslations("settings.marketplace");
  const [configured, setConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/marketplaces/token")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setConfigured(!!d?.configured))
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/marketplaces/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (r.ok) {
        setConfigured(true);
        setValue("");
        toast.success(t("tokenSaved"));
      } else toast.error(t("tokenSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/marketplaces/token", { method: "DELETE" });
      if (r.ok) {
        setConfigured(false);
        toast.success(t("tokenCleared"));
      } else toast.error(t("tokenClearFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{t("tokenTitle")}</p>
        {configured && (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" />
            {t("tokenConfigured")}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          placeholder={t("tokenPlaceholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <Button size="sm" onClick={save} disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("tokenSave")}
        </Button>
        {configured && (
          <Button size="sm" variant="ghost" onClick={clear} disabled={busy}>
            {t("tokenClear")}
          </Button>
        )}
      </div>
    </div>
  );
}
