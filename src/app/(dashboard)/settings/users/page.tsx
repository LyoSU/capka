"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Users, KeyRound } from "lucide-react";
import { SettingsPage } from "@/components/settings/shell";
import { SettingsTabs } from "@/components/settings/tabs";
import { PeopleTab } from "./people-tab";
import { SignInTab } from "./signin-tab";

/**
 * Settings → People: who may use this instance, and how they get in.
 *
 * These were two pages, and the split cut across one question. "Who is in" (roles,
 * approvals, spend) lived on Users, "who may get in" (registration mode, e-mail
 * sign-up, Telegram login) on Authentication — so approving a pending person and
 * deciding whether pending people can exist at all were in different places. The
 * old page even carried a link saying approvals had moved.
 */
export default function PeoplePage() {
  const t = useTranslations("settings.people");
  const [tab, setTab] = useState<"people" | "signin">("people");

  // Honor ?tab=signin, which is where /settings/authentication now redirects.
  const tabParam = useSearchParams().get("tab");
  useEffect(() => {
    if (tabParam === "signin") setTab("signin");
  }, [tabParam]);

  return (
    <SettingsPage title={t("title")} description={t("subtitle")} wide={tab === "people"}>
      <SettingsTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "people", label: t("tab.people"), icon: Users },
          { key: "signin", label: t("tab.signin"), icon: KeyRound },
        ]}
      />
      {tab === "people" ? <PeopleTab /> : <SignInTab />}
    </SettingsPage>
  );
}
