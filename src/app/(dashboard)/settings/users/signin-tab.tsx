"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { SettingsChoice, SettingsGroup, SettingsRow, SettingsSection, SettingsSkeleton } from "@/components/settings/shell";
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
    <div className="space-y-10">
      {/* Telegram login provider — a row with its switch, and the credential
          fields folded under it while it is on. Same card, same row anatomy as
          every other setting, so this page stops being the one with its own look. */}
      <SettingsSection title={t("telegram.title")} description={t("telegram.desc")}>
        <SettingsGroup>
          <SettingsRow
            title={t("telegram.title")}
            hint={enabled ? t("telegram.botFatherHint") : undefined}
            onLabelClick={() => { const v = !enabled; setEnabled(v); persist({ enabled: v }, () => setEnabled(!v)); }}
            control={
              <div className="flex items-center gap-2.5">
                {enabled && (
                  <Badge variant={ready ? "secondary" : "outline"} className="text-xs">
                    {ready ? t("telegram.active") : t("telegram.incomplete")}
                  </Badge>
                )}
                <Switch
                  checked={enabled}
                  onCheckedChange={(v) => { setEnabled(v); persist({ enabled: v }, () => setEnabled(!v)); }}
                  aria-label={t("telegram.toggleAria")}
                />
              </div>
            }
          >
            {enabled && (
              <div className="space-y-3">
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
                    <code className="flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-[13px]">{redirectUri}</code>
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
                  <p className="text-[13px] text-muted-foreground">{t("telegram.redirectHint")}</p>
                </div>
                {/* Sits with the two fields it saves, and only once they differ from
                    what's stored — so nothing on this tab is silently unsaved. */}
                {credentialsDirty && (
                  <div className="flex items-center justify-end gap-3">
                    <p className="text-[13px] text-warning-text">{t("unsavedCredentials")}</p>
                    <Button size="sm" onClick={save} disabled={saving} className="animate-step-in">
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("save")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      {/* Registration mode */}
      <SettingsSection
        title={t("mode.title")}
        description={t("mode.desc")}
        // Approvals are the sibling tab now, not another page — say where, don't
        // navigate away from a form that may have unsaved changes.
        footnote={mode === "approval" ? t("pending.moved") : undefined}
      >
        <SettingsChoice
          value={mode}
          onChange={(key) => { const prev = mode; setMode(key); persist({ registrationMode: key }, () => setMode(prev)); }}
          label={t("mode.title")}
          options={modes.map(({ key }) => ({ key, label: t(`mode.${key}.label`), hint: t(`mode.${key}.desc`) }))}
        />
      </SettingsSection>

      {/* Email sign-up toggle — a separate axis from the mode above. Off = no new
          email accounts; existing email users still sign in, and Telegram (if
          configured) stays open. */}
      <SettingsGroup>
        <SettingsRow
          title={t("email.title")}
          hint={t("email.desc")}
          warning={!emailSignup && !ready ? t("email.deadEndWarning") : undefined}
          onLabelClick={() => { const v = !emailSignup; setEmailSignup(v); persist({ emailSignupEnabled: v }, () => setEmailSignup(!v)); }}
          control={
            <Switch
              checked={emailSignup}
              onCheckedChange={(v) => { setEmailSignup(v); persist({ emailSignupEnabled: v }, () => setEmailSignup(!v)); }}
              aria-label={t("email.toggleAria")}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
