"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";

function useSetting(key: string, fallback: string) {
  const t = useTranslations("settings.general");
  const tc = useTranslations("common");
  const [value, setValue] = useState(fallback);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/settings?key=${key}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.value != null) setValue(data.value);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [key]);

  const update = useCallback((v: string) => {
    setValue(v);
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      toast.success(tc("saved"));
      setDirty(false);
    } else toast.error(t("saveFailed"));
  }, [key, value, t, tc]);

  return { value, update, save, dirty, loading };
}

export default function GeneralSettingsPage() {
  const isAdmin = useIsAdmin();
  const tLang = useTranslations("language");
  const t = useTranslations("settings.general");
  const tc = useTranslations("common");

  const minCtx = useSetting("model_min_context", String(DEFAULT_MODEL_MIN_CONTEXT));
  const sandbox = useSetting("sandbox_enabled", "false");
  const registration = useSetting("registration_enabled", "true");
  const blockPrivate = useSetting("block_private_provider_urls", "false");

  const settingsLoading = minCtx.loading || sandbox.loading || registration.loading || blockPrivate.loading;

  const contextLabel = (val: string) => {
    const n = parseInt(val, 10);
    if (!n || n <= 0) return "";
    if (n >= 1_000_000) return t("tokensM", { value: (n / 1_000_000).toFixed(1) });
    return t("tokensK", { value: (n / 1_000).toFixed(0) });
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      {/* Theme */}
      <div>
        <h2 className="text-base font-medium">{t("appearance")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("appearanceDesc")}
        </p>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t("theme")}</label>
        <ThemeSwitcher />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{tLang("label")}</label>
        <LanguageSwitcher />
      </div>

      {isAdmin && (
        <>
          <Separator />

          {/* Model filter — admin only */}
          <div>
            <h2 className="text-base font-medium">{t("modelFilter")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("modelFilterDesc")}
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("minContext")}</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={minCtx.value}
                  onChange={(e) => minCtx.update(e.target.value)}
                  placeholder="100000"
                  className="w-40"
                />
                <span className="text-sm text-muted-foreground">
                  {contextLabel(minCtx.value)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("minContextHint")}
              </p>
            </div>
            {minCtx.dirty && (
              <Button size="sm" onClick={minCtx.save}>{tc("save")}</Button>
            )}
          </div>

          <Separator />

          {/* Sandbox — admin only */}
          <div>
            <h2 className="text-base font-medium">{t("sandbox")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("sandboxDesc")}
            </p>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">{t("enableSandbox")}</p>
              <p className="text-xs text-muted-foreground">
                {t("enableSandboxHint")}
              </p>
            </div>
            <Switch
              checked={sandbox.value === "true"}
              onCheckedChange={(checked) => {
                sandbox.update(checked ? "true" : "false");
                fetch("/api/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ key: "sandbox_enabled", value: checked ? "true" : "false" }),
                }).then((r) => {
                  if (r.ok) toast.success(checked ? t("sandboxEnabled") : t("sandboxDisabled"));
                  else toast.error(t("updateFailed"));
                });
              }}
            />
          </div>

          <Separator />

          {/* Registration — admin only */}
          <div>
            <h2 className="text-base font-medium">{t("registration")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("registrationDesc")}
            </p>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">{t("allowRegistration")}</p>
              <p className="text-xs text-muted-foreground">
                {t("allowRegistrationHint")}
              </p>
            </div>
            <Switch
              checked={registration.value === "true"}
              onCheckedChange={(checked) => {
                registration.update(checked ? "true" : "false");
                fetch("/api/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ key: "registration_enabled", value: checked ? "true" : "false" }),
                }).then((r) => {
                  if (r.ok) toast.success(checked ? t("registrationEnabled") : t("registrationDisabled"));
                  else toast.error(t("updateFailed"));
                });
              }}
            />
          </div>

          <Separator />

          {/* Security — admin only */}
          <div>
            <h2 className="text-base font-medium">{t("security")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("securityDesc")}
            </p>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="pr-4">
              <p className="text-sm font-medium">{t("blockPrivate")}</p>
              <p className="text-xs text-muted-foreground">
                {t("blockPrivateHint")}
              </p>
            </div>
            <Switch
              checked={blockPrivate.value === "true"}
              onCheckedChange={(checked) => {
                blockPrivate.update(checked ? "true" : "false");
                fetch("/api/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ key: "block_private_provider_urls", value: checked ? "true" : "false" }),
                }).then((r) => {
                  if (r.ok) toast.success(checked ? t("strictEnabled") : t("strictDisabled"));
                  else toast.error(t("updateFailed"));
                });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
