"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw, Trash2, Sparkles, Plug, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PluginIcon } from "@/components/plugin-icon";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

interface Item { id: string; name: string; enabled: boolean }
interface InstalledPlugin {
  id: string;
  pluginName: string;
  displayName: string | null;
  version: string | null;
  author: string | null;
  homepage: string | null;
  enabledState: "on" | "off" | "mixed";
  notes: string[];
  skills: Item[];
  connectors: (Item & { transport: string })[];
}

/** The Extensions tab: each installed plugin shown as one unit with its skills +
 *  connectors and group-level actions (enable/disable/update/uninstall), so the
 *  pieces a plugin adds are managed together instead of scattered. */
export default function InstalledPlugins() {
  const t = useTranslations("settings.skills.installed");
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/extensions");
      if (r.ok) setPlugins((await r.json()).plugins ?? []);
      else toast.error(t("loadError"));
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const act = async (req: () => Promise<Response>, id: string, okMsg?: string) => {
    setBusy(id);
    try {
      const r = await req();
      const d = await r.json().catch(() => ({}));
      if (r.ok) { if (okMsg) toast.success(okMsg); await load(); }
      else toast.error(d.error || t("actionFailed"));
    } catch {
      toast.error(t("actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: InstalledPlugin) =>
    act(() => fetch("/api/admin/extensions", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: p.id, enabled: p.enabledState !== "on" }),
    }), p.id);

  const update = (p: InstalledPlugin) =>
    act(() => fetch("/api/admin/extensions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: p.id }),
    }), p.id, t("updated"));

  const uninstall = (p: InstalledPlugin) =>
    act(() => fetch(`/api/admin/extensions?installId=${encodeURIComponent(p.id)}`, { method: "DELETE" }), p.id, t("uninstalled"));

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!plugins.length) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }

  const stateVariant = (s: InstalledPlugin["enabledState"]) =>
    s === "on" ? "default" : s === "off" ? "secondary" : "outline";

  return (
    <div className="space-y-3">
      {plugins.map((p) => {
        const title = p.displayName || p.pluginName;
        return (
          <div key={p.id} className="space-y-3 rounded-xl border p-4">
            <div className="flex items-start gap-3">
              <PluginIcon name={title} homepage={p.homepage} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{title}</span>
                  {p.version && <span className="text-xs text-muted-foreground">v{p.version}</span>}
                  <Badge variant={stateVariant(p.enabledState)}>{t(`state.${p.enabledState}`)}</Badge>
                </div>
                {p.author && <p className="text-xs text-muted-foreground">{t("by", { author: p.author })}</p>}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("counts", { skills: p.skills.length, connectors: p.connectors.length })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => toggle(p)}>
                  {p.enabledState === "on" ? t("disable") : t("enable")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => update(p)} aria-label={t("update")}>
                  {busy === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button size="sm" variant="ghost" disabled={busy === p.id} aria-label={t("uninstall")}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("uninstall")}</AlertDialogTitle>
                      <AlertDialogDescription>{t("uninstallConfirm", { name: title })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => uninstall(p)}>{t("uninstall")}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            {(p.skills.length > 0 || p.connectors.length > 0) && (
              <div className="flex flex-wrap gap-1.5 border-t pt-3">
                {p.skills.map((s) => (
                  <Badge key={s.id} variant="outline" className={cn("gap-1 font-normal", !s.enabled && "opacity-50")}>
                    <Sparkles className="h-3 w-3" />{s.name}
                  </Badge>
                ))}
                {p.connectors.map((c) => (
                  <Badge key={c.id} variant="outline" className={cn("gap-1 font-normal", !c.enabled && "opacity-50")}>
                    <Plug className="h-3 w-3" />{c.name}
                  </Badge>
                ))}
              </div>
            )}

            {p.notes.length > 0 && (
              <ul className="space-y-1 border-t pt-3 text-xs text-amber-600 dark:text-amber-500">
                {p.notes.map((n, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{n}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
