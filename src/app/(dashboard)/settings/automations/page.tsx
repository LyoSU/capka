"use client";

import { useTranslations } from "next-intl";
import { MessageSquare } from "lucide-react";
import { SettingsPage } from "@/components/settings/shell";
import AutomationsList from "./automations-list";

export default function AutomationsPage() {
  const t = useTranslations("settings.automations");

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <AutomationsList />
      {/* A tip, not an instruction, so it reads last: the reader came for the
          list, and a sentence about the chat before the list made them look for
          the list somewhere else. */}
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <MessageSquare className="size-4 shrink-0" aria-hidden />
        {t("chatHint")}
      </p>
    </SettingsPage>
  );
}
