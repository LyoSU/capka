"use client";

import { useTranslations } from "next-intl";
import { MessageSquare } from "lucide-react";
import { SettingsPage } from "@/components/settings/shell";
import AutomationsList from "./automations-list";

export default function AutomationsPage() {
  const t = useTranslations("settings.automations");

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <p className="-mt-6 flex items-center gap-1.5 text-xs text-muted-foreground/80">
        <MessageSquare className="h-3 w-3" />
        {t("chatHint")}
      </p>
      <AutomationsList />
    </SettingsPage>
  );
}
