"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Library, Plug, Package, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";
import SkillLibrary from "@/components/settings/skill-library";
import ConnectorList from "@/components/settings/connector-list";
import PluginsPanel, { type PluginsView } from "@/components/settings/plugins-panel";

type Tab = "library" | "connectors" | "plugins";

export default function CustomizePage() {
  const t = useTranslations("settings.skills");
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<Tab>("library");
  const [pluginsView, setPluginsView] = useState<PluginsView>("installed");

  // Honor ?tab= (old /settings/{marketplace,connectors} redirects + the MCP OAuth
  // round-trip) without useSearchParams, which would force Suspense. Marketplace is
  // now the Browse view inside the merged Plugins tab.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("tab");
    // Reading the URL must happen post-mount (no window on the server); an effect
    // is the right tool here and avoids a hydration mismatch on the default tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q === "connectors") setTab("connectors");
    else if (q === "installed" || q === "plugins") setTab("plugins");
    else if (q === "marketplace") {
      setTab("plugins");
      setPluginsView("browse");
    }
  }, []);

  const tabs: { key: Tab; label: string; icon: typeof Library; adminOnly?: boolean }[] = [
    { key: "library", label: t("tab.library"), icon: Library },
    { key: "connectors", label: t("tab.connectors"), icon: Plug },
    // Plugins is visible to everyone (read-only + per-user OAuth sign-in); only
    // admins get the management actions + the Browse/marketplace view inside it.
    { key: "plugins", label: t("tab.installed"), icon: Package },
  ];
  const visibleTabs = tabs.filter((tb) => !tb.adminOnly || isAdmin);
  const active = visibleTabs.some((tb) => tb.key === tab) ? tab : "library";

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

      {/* Segmented control */}
      <div className="inline-flex rounded-lg border bg-muted/40 p-1">
        {visibleTabs.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              active === tb.key ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <tb.icon className="h-4 w-4" />
            {tb.label}
          </button>
        ))}
      </div>

      {active === "library" && <SkillLibrary chrome={false} />}
      {active === "connectors" && <ConnectorList chrome={false} />}
      {active === "plugins" && <PluginsPanel view={pluginsView} onView={setPluginsView} />}
    </div>
  );
}
