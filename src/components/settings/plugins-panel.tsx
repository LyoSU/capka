"use client";

import { useTranslations } from "next-intl";
import { Package, Store } from "lucide-react";
import { cn } from "@/lib/utils";
import InstalledPlugins from "@/components/settings/installed-plugins";
import { MarketplaceBrowser } from "@/components/settings/marketplace-browser";

export type PluginsView = "installed" | "browse";

/** The Plugins hub (app-store pattern): "Installed" manages what's added, "Browse"
 *  is the marketplace. Merged so everything plugin-related lives under one tab. */
export default function PluginsPanel({ view, onView }: { view: PluginsView; onView: (v: PluginsView) => void }) {
  const t = useTranslations("settings.skills.pluginsView");
  const views: { key: PluginsView; label: string; icon: typeof Package }[] = [
    { key: "installed", label: t("installed"), icon: Package },
    { key: "browse", label: t("browse"), icon: Store },
  ];

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border bg-muted/40 p-1">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => onView(v.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              view === v.key ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <v.icon className="h-4 w-4" />
            {v.label}
          </button>
        ))}
      </div>

      {view === "installed" ? <InstalledPlugins /> : <MarketplaceBrowser />}
    </div>
  );
}
