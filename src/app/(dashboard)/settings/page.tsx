"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { TelegramLinkCard } from "@/components/settings/telegram-link-card";
import { UsageLimitCard } from "@/components/settings/usage-limit-card";
import { authClient } from "@/lib/auth-client";

function AccountSection() {
  const t = useTranslations("settings.general");
  const tc = useTranslations("common");
  const { data: session, isPending, refetch } = authClient.useSession();
  const user = session?.user;

  // `null` means "not edited yet — follow the session". Once the user types,
  // `name` holds a string and the input stops tracking the session. No effect,
  // no sync races: the field is derived state layered over the source of truth.
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = name ?? user?.name ?? "";
  const dirty = name !== null && name !== (user?.name ?? "");

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error(t("nameRequired"));
      return;
    }
    setSaving(true);
    const { error } = await authClient.updateUser({ name: trimmed });
    setSaving(false);
    if (error) {
      toast.error(t("nameSaveFailed"));
      return;
    }
    setName(null); // hand control back to the (now-updated) session
    await refetch();
    toast.success(t("nameSaved"));
  };

  return (
    <>
      <div>
        <h2 className="text-base font-medium">{t("account")}</h2>
        <p className="text-sm text-muted-foreground">{t("accountDesc")}</p>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t("name")}</label>
        <div className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            disabled={isPending}
            className="max-w-xs"
          />
          {dirty && (
            <Button size="sm" onClick={save} disabled={saving}>{tc("save")}</Button>
          )}
        </div>
      </div>
      {user?.email && (
        <div className="space-y-1.5">
          <label className="block text-sm font-medium">{t("email")}</label>
          <Input value={user.email} disabled className="max-w-xs" />
        </div>
      )}
    </>
  );
}

export default function GeneralSettingsPage() {
  const tLang = useTranslations("language");
  const t = useTranslations("settings.general");

  return (
    <div className="max-w-lg space-y-6">
      {/* Account — personal identity, every role */}
      <AccountSection />

      {/* Appearance — personal, every role */}
      <Separator />
      <div>
        <h2 className="text-base font-medium">{t("appearance")}</h2>
        <p className="text-sm text-muted-foreground">{t("appearanceDesc")}</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t("theme")}</label>
        <ThemeSwitcher />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{tLang("label")}</label>
        <LanguageSwitcher />
      </div>

      {/* Personal budget status (% only) — renders itself away when there's no
          shared-key limit to show. Visible to every role. */}
      <UsageLimitCard />

      {/* Personal Telegram linking — open to every role; the bot token itself is
          configured by an admin in Settings → Integrations. */}
      <Separator />
      <TelegramLinkCard />
    </div>
  );
}
