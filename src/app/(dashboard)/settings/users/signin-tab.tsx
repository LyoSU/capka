"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Copy, Check, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { SettingsSkeleton } from "@/components/settings/shell";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";

type Mode = "open" | "approval" | "closed";
interface Config {
  telegram: { enabledToggle: boolean; ready: boolean; clientId: string; hasClientSecret: boolean; redirectUri: string };
  registrationMode: Mode;
  emailSignupEnabled: boolean;
}

export function SignInTab() {
  const t = useTranslations("settings.authentication");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [mode, setMode] = useState<Mode>("closed");
  const [emailSignup, setEmailSignup] = useState(true);
  const [redirectUri, setRedirectUri] = useState("");
  const [copied, setCopied] = useState(false);
  // The stored client id, so Save can tell "edited" from "just loaded".
  const [savedClientId, setSavedClientId] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/auth-config");
      if (res.ok) {
        const data: Config = await res.json();
        setEnabled(data.telegram.enabledToggle);
        setClientId(data.telegram.clientId);
        setSavedClientId(data.telegram.clientId);
        setHasSecret(data.telegram.hasClientSecret);
        setRedirectUri(data.telegram.redirectUri);
        setMode(data.registrationMode);
        setEmailSignup(data.emailSignupEnabled);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  /**
   * Persist one field and undo the optimistic UI if the server refuses.
   *
   * Every field on POST /api/admin/auth-config is optional and applied only when
   * present, so a switch can commit itself without dragging a half-typed client
   * id along. That is what makes save-on-toggle safe here — and these switches
   * look exactly like the instantly-saved ones on Security and Agent, so
   * deferring them behind Save is how a flipped toggle used to vanish on
   * navigation.
   */
  const persist = async (patch: Record<string, unknown>, rollback: () => void) => {
    const res = await fetch("/api/admin/auth-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      rollback();
      toast.error(t("saveFailed"));
    }
  };

  // Credentials stay deferred: a client id/secret is only meaningful once typed
  // in full, so those two fields keep the explicit Save.
  const credentialsDirty = clientId.trim() !== savedClientId || !!clientSecret.trim();

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { clientId: clientId.trim() };
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      const res = await fetch("/api/admin/auth-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("saved"));
        setClientSecret("");
        await load();
      } else {
        toast.error(t("saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const copyRedirect = async () => {
    if (!(await copyToClipboard(redirectUri))) return;
    setCopied(true);
    toast.success(t("copied"));
    setTimeout(() => setCopied(false), 2000);
  };

  const modes: { key: Mode; }[] = [{ key: "open" }, { key: "approval" }, { key: "closed" }];
  // "Active" = toggle on AND credentials present (stored secret or a fresh one).
  const ready = enabled && !!clientId.trim() && (hasSecret || !!clientSecret.trim());

  if (loading) return <SettingsSkeleton rows={3} header={false} />;

  return (
    <div className="space-y-6">
      {/* Telegram login provider */}
      <div className="space-y-4 rounded-md border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#229ED9]/10">
              <Send className="h-4.5 w-4.5 text-[#229ED9]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{t("telegram.title")}</h3>
                {enabled && (
                  <Badge variant={ready ? "secondary" : "outline"} className="text-xs">
                    {ready ? t("telegram.active") : t("telegram.incomplete")}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{t("telegram.desc")}</p>
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => { setEnabled(v); persist({ enabled: v }, () => setEnabled(!v)); }}
            aria-label={t("telegram.toggleAria")}
          />
        </div>

        {enabled && (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-muted-foreground">{t("telegram.botFatherHint")}</p>
            <div className="space-y-1.5">
              <Label htmlFor="clientId">{t("telegram.clientId")}</Label>
              <Input id="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="8521897198" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientSecret">{t("telegram.clientSecret")}</Label>
              <Input
                id="clientSecret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={hasSecret ? t("telegram.secretStored") : t("telegram.secretPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("telegram.redirectUri")}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 text-xs font-mono">{redirectUri}</code>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={copyRedirect}
                  aria-label={copied ? t("copied") : t("copyRedirect")}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
                <span role="status" aria-live="polite" className="sr-only">{copied ? t("copied") : ""}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t("telegram.redirectHint")}</p>
            </div>
            {/* Sits with the two fields it saves, and only once they differ from
                what's stored — so nothing on this tab is silently unsaved. */}
            {credentialsDirty && (
              <div className="flex items-center justify-end gap-3">
                <p className="text-xs text-warning-text">{t("unsavedCredentials")}</p>
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("save")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Registration mode */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t("mode.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("mode.desc")}</p>
        </div>
        {/* radiogroup + aria-checked: these are radio buttons drawn by hand, and
            without the roles the chosen one was signalled only by a filled circle
            and a background — nothing a screen reader can report. */}
        <div role="radiogroup" aria-label={t("mode.title")} className="grid gap-2">
          {modes.map(({ key }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              onClick={() => { const prev = mode; setMode(key); persist({ registrationMode: key }, () => setMode(prev)); }}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                mode === key ? "border-foreground/40 bg-hover-strong" : "hover:bg-hover",
              )}
            >
              <div aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0 rounded-full border-2", mode === key ? "border-foreground bg-foreground" : "border-muted-foreground/40")} />
              <div>
                <p className="text-sm font-medium">{t(`mode.${key}.label`)}</p>
                <p className="text-xs text-muted-foreground">{t(`mode.${key}.desc`)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Email sign-up toggle — a separate axis from the mode above. Off = no new
          email accounts; existing email users still sign in, and Telegram (if
          configured) stays open. */}
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">{t("email.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("email.desc")}</p>
          </div>
          <Switch
            checked={emailSignup}
            onCheckedChange={(v) => { setEmailSignup(v); persist({ emailSignupEnabled: v }, () => setEmailSignup(!v)); }}
            aria-label={t("email.toggleAria")}
          />
        </div>
        {!emailSignup && !ready && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-foreground">
            {t("email.deadEndWarning")}
          </p>
        )}
      </div>

      {/* Approvals are the sibling tab now, not another page — say where, don't
          navigate away from a form that may have unsaved changes. */}
      {mode === "approval" && (
        <p className="text-xs text-muted-foreground">{t("pending.moved")}</p>
      )}
    </div>
  );
}
