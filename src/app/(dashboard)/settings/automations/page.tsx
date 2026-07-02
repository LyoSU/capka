"use client";

import { useTranslations } from "next-intl";
import { MessageSquare } from "lucide-react";
import AutomationsList from "./automations-list";

export default function AutomationsPage() {
  const t = useTranslations("settings.automations");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/80">
          <MessageSquare className="h-3 w-3" />
          {t("chatHint")}
        </p>
      </div>

      <AutomationsList />
    </div>
  );
}
