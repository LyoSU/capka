"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw, Trash2, Sparkles, Plug, AlertTriangle, CheckCircle2, Power, PowerOff, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
  /** The git commit this install is pinned to (provenance), and its date. */
  commitSha: string | null;
  commitDate: string | null;
  author: string | null;
  homepage: string | null;
  enabledState: "on" | "off" | "mixed";
  scope: string;
  /** A personal install this user owns — they may manage it without being admin. */
  mine: boolean;
  /** This user has hidden the (shared) plugin for themselves. */
  mutedByMe: boolean;
  notes: string[];
  skills: Item[];
  connectors: (Item & { transport: string })[];
}

/** What GET /api/extensions/preview returns: the target commit and, if it differs
 *  from the pin, the file-level diff to review before applying the update. */
interface UpgradePreview {
  changed: boolean;
  fromSha: string | null;
  to: { sha: string; date: string | null; message: string | null };
  diff?: { added: string[]; removed: string[]; modified: string[] };
  touchesConnectors?: boolean;
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
  // The upgrade-review dialog: set after a preview reports real changes, so the
  // operator confirms exactly what an update brings before the pin is moved.
  const [review, setReview] = useState<{ plugin: InstalledPlugin; preview: UpgradePreview } | null>(null);

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
    if (h?.status === "ok") return { label: t("status.active", { count: h.toolCount ?? 0 }), cls: "text-success", Icon: CheckCircle2, detail: undefined };
    if (h) {
      const label = h.status === "needs_login" ? t("status.needsLogin") : h.status === "unauthorized" ? t("status.unauthorized") : t("status.error");
      return { label, cls: "text-warning-text", Icon: AlertTriangle, detail: h.detail };
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

  // Step 1: preview. Up to date → just say so; real changes → open the review
  // dialog. Moving the pin (the actual re-pull) only happens on confirm (step 2).
  const checkUpdate = async (p: InstalledPlugin) => {
    setBusy(p.id);
    try {
      const r = await fetch(`/api/extensions/preview?installId=${encodeURIComponent(p.id)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || t("previewFailed")); return; }
      const preview = d as UpgradePreview;
      if (!preview.changed) { toast.success(t("upToDate")); return; }
      setReview({ plugin: p, preview });
    } catch {
      toast.error(t("previewFailed"));
    } finally {
      setBusy(null);
    }
  };

  // Step 2: apply — re-pull from source, moving the pin to the previewed commit.
  const applyUpdate = (p: InstalledPlugin) => {
    setReview(null);
    return act(() => fetch("/api/extensions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: p.id }),
    }), p.id, t("updated"));
  };

  const uninstall = (p: InstalledPlugin) =>
    act(() => fetch(`/api/extensions?installId=${encodeURIComponent(p.id)}`, { method: "DELETE" }), p.id, t("uninstalled"));

  // Per-user OAuth sign-in (every user does their own — not an admin action).
  const signIn = (id: string) => { window.location.href = `/api/mcp/oauth/start?serverId=${encodeURIComponent(id)}`; };

  // Per-user hide of a shared plugin (members can't manage it, but can hide it).
  const setMuted = (p: InstalledPlugin, muted: boolean) =>
    act(() => fetch("/api/extensions", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: p.id, muted }),
    }), p.id);

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
                  {p.commitSha && (
                    <code
                      className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
                      title={p.commitDate ? `${p.commitSha} · ${new Date(p.commitDate).toLocaleString()}` : p.commitSha}
                    >
                      #{p.commitSha.slice(0, 7)}
                    </code>
                  )}
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
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => checkUpdate(p)} aria-label={t("update")}>
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

              {/* A member can't manage a shared plugin, but can hide it for
                  themselves (per-user mute of its skills + connectors). */}
              {!isAdmin && !p.mine && p.scope === "system" && (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">{p.mutedByMe ? t("hidden") : t("shown")}</span>
                  <Switch
                    checked={!p.mutedByMe}
                    disabled={busy === p.id}
                    onCheckedChange={(v) => setMuted(p, !v)}
                    aria-label={t("hideForMe")}
                  />
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
              <ul className="space-y-1 border-t pt-3 text-xs text-warning-text">
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

      {/* Upgrade review: opened after a preview found real changes. Shows the
          target commit + a counts summary, and warns loudly when a connector
          definition changed (new code that could run in the sandbox). */}
      <AlertDialog open={!!review} onOpenChange={(o) => { if (!o) setReview(null); }}>
        <AlertDialogContent>
          {review && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("reviewTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("reviewDesc", {
                    name: review.plugin.displayName || review.plugin.pluginName,
                    from: review.preview.fromSha ? `#${review.preview.fromSha.slice(0, 7)}` : "—",
                    to: `#${review.preview.to.sha.slice(0, 7)}`,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {review.preview.to.message && (
                <p className="truncate text-xs text-muted-foreground" title={review.preview.to.message}>
                  {review.preview.to.message}
                </p>
              )}
              {review.preview.diff && (
                <p className="text-xs text-muted-foreground">
                  {t("reviewChanges", {
                    added: review.preview.diff.added.length,
                    removed: review.preview.diff.removed.length,
                    modified: review.preview.diff.modified.length,
                  })}
                </p>
              )}
              {review.preview.touchesConnectors && (
                <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 p-2 text-xs text-warning-text">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("reviewConnectorsWarning")}
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => applyUpdate(review.plugin)}>{t("reviewApply")}</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
