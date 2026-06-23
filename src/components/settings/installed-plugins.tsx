"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw, Trash2, Sparkles, Plug, AlertTriangle, CheckCircle2, Power, PowerOff, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PluginIcon } from "@/components/plugin-icon";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { cn } from "@/lib/utils";

interface Item { id: string; name: string; enabled: boolean }
type ProbeStatus = "ok" | "unauthorized" | "unreachable" | "needs_login";
interface Health { status: ProbeStatus; toolCount?: number; detail?: string }
interface InstalledPlugin {
  id: string;
  pluginName: string;
  displayName: string | null;
  version: string | null;
  author: string | null;
  homepage: string | null;
  enabledState: "on" | "off" | "mixed";
  /** A personal install this user owns — they may manage it without being admin. */
  mine: boolean;
  notes: string[];
  skills: Item[];
  connectors: (Item & { transport: string })[];
}

/** The Extensions tab: each installed plugin shown as one unit with its skills +
 *  connectors and group-level actions (enable/disable/update/uninstall), so the
 *  pieces a plugin adds are managed together instead of scattered. */
export default function InstalledPlugins() {
  const t = useTranslations("settings.skills.installed");
  const isAdmin = useIsAdmin();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Health is live connection state per connector — it's why a connector that
      // looks installed may still be invisible to the assistant (disabled / errored).
      const [r, hr] = await Promise.all([fetch("/api/extensions"), fetch("/api/mcp/health")]);
      if (r.ok) setPlugins((await r.json()).plugins ?? []);
      else toast.error(t("loadError"));
      if (hr.ok) setHealth((await hr.json()).health ?? {});
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  /** Per-connector status the card shows so it's obvious why the assistant does or
   *  doesn't see it: off → enable it; error → here's the reason; ok → tool count. */
  const connectorStatus = (c: Item) => {
    if (!c.enabled) return { label: t("status.disabled"), cls: "text-muted-foreground", Icon: PowerOff, detail: undefined as string | undefined };
    const h = health[c.id];
    if (h?.status === "ok") return { label: t("status.active", { count: h.toolCount ?? 0 }), cls: "text-emerald-600 dark:text-emerald-500", Icon: CheckCircle2, detail: undefined };
    if (h) {
      const label = h.status === "needs_login" ? t("status.needsLogin") : h.status === "unauthorized" ? t("status.unauthorized") : t("status.error");
      return { label, cls: "text-amber-600 dark:text-amber-500", Icon: AlertTriangle, detail: h.detail };
    }
    // Enabled but no probe result (stdio connects only inside a run; success isn't recorded).
    return { label: t("status.enabled"), cls: "text-muted-foreground", Icon: Power, detail: undefined };
  };

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
    act(() => fetch("/api/extensions", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: p.id, enabled: p.enabledState !== "on" }),
    }), p.id);

  const update = (p: InstalledPlugin) =>
    act(() => fetch("/api/extensions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: p.id }),
    }), p.id, t("updated"));

  const uninstall = (p: InstalledPlugin) =>
    act(() => fetch(`/api/extensions?installId=${encodeURIComponent(p.id)}`, { method: "DELETE" }), p.id, t("uninstalled"));

  // Per-user OAuth sign-in (every user does their own — not an admin action).
  const signIn = (id: string) => { window.location.href = `/api/mcp/oauth/start?serverId=${encodeURIComponent(id)}`; };

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
              {/* Managing a plugin (enable/update/uninstall): admins for org-wide
                  installs, members for their own personal ones. Everyone else gets a
                  read-only card + per-user sign-in on the connectors. */}
              {(isAdmin || p.mine) && (
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
              )}
            </div>

            {p.skills.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t pt-3">
                {p.skills.map((s) => (
                  <Badge key={s.id} variant="outline" className={cn("gap-1 font-normal", !s.enabled && "opacity-50")}>
                    <Sparkles className="h-3 w-3" />{s.name}
                  </Badge>
                ))}
              </div>
            )}

            {p.connectors.length > 0 && (
              <div className="space-y-1.5 border-t pt-3">
                {p.connectors.map((c) => {
                  const st = connectorStatus(c);
                  const needsLogin = health[c.id]?.status === "needs_login";
                  return (
                    <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className={cn("flex items-center gap-1 text-xs", st.cls)} title={st.detail}>
                          <st.Icon className="h-3 w-3" />{st.label}
                        </span>
                        {needsLogin && (
                          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => signIn(c.id)}>
                            <LogIn className="mr-1 h-3 w-3" />{t("signIn")}
                          </Button>
                        )}
                      </span>
                    </div>
                  );
                })}
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
