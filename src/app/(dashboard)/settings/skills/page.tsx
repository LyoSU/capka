"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Library, Plug, Package, MessageSquare, ShieldCheck } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import SkillLibrary from "@/components/settings/skill-library";
import ConnectorList from "@/components/settings/connector-list";
import PluginsPanel, { type PluginsView } from "@/components/settings/plugins-panel";
import { SettingsPage } from "@/components/settings/shell";
import { SettingsTabs } from "@/components/settings/tabs";
import { PermissionsTab } from "./permissions-tab";

type Tab = "library" | "connectors" | "plugins" | "permissions";

export default function CustomizePage() {
  const t = useTranslations("settings.skills");
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<Tab>("library");
  const [pluginsView, setPluginsView] = useState<PluginsView>("installed");

  // Honor ?tab= (old /settings/{marketplace,connectors} redirects, the MCP OAuth
  // round-trip, and the library's "Browse marketplace" link). Marketplace is now
  // the Browse view inside the merged Plugins tab.
  //
  // Must read the LIVE param, not window.location.search once on mount: the
  // "Browse marketplace" button links to this same pathname with a different
  // query, so React never remounts this page (RouteTransition keys its boundary
  // by pathname) and a mount-only effect never re-ran — the URL changed and the
  // view didn't, which is exactly how that button looked broken.
  const tabParam = useSearchParams().get("tab");
  useEffect(() => {
    if (tabParam === "connectors") setTab("connectors");
    else if (tabParam === "installed" || tabParam === "plugins") setTab("plugins");
    else if (tabParam === "permissions") setTab("permissions");
    else if (tabParam === "marketplace") {
      setTab("plugins");
      setPluginsView("browse");
    }
  }, [tabParam]);

  const tabs: { key: Tab; label: string; icon: typeof Library; adminOnly?: boolean }[] = [
    { key: "library", label: t("tab.library"), icon: Library },
    { key: "connectors", label: t("tab.connectors"), icon: Plug },
    // Plugins is visible to everyone (read-only + per-user OAuth sign-in); only
    // admins get the management actions + the Browse/marketplace view inside it.
    { key: "plugins", label: t("tab.installed"), icon: Package },
    // Governance sits beside the things it governs — /settings/permissions
    // redirects here. Admin-only, unlike the tabs above it.
    { key: "permissions", label: t("tab.permissions"), icon: ShieldCheck, adminOnly: true },
  ];
  const visibleTabs = tabs.filter((tb) => !tb.adminOnly || isAdmin);
  const active = visibleTabs.some((tb) => tb.key === tab) ? tab : "library";

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
        <MessageSquare className="h-3 w-3" />
        {t("chatHint")}
      </p>

      <SettingsTabs value={active} onChange={setTab} tabs={visibleTabs} />

      {active === "library" && <SkillLibrary chrome={false} />}
      {active === "connectors" && <ConnectorList chrome={false} />}
      {active === "plugins" && <PluginsPanel view={pluginsView} onView={setPluginsView} />}
      {active === "permissions" && <PermissionsTab />}
    </SettingsPage>
  );
}
