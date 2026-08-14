"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw, Trash2, Sparkles, Plug, Package, AlertTriangle, CheckCircle2, ChevronDown, Power, PowerOff, LogIn } from "lucide-react";
import { toast } from "sonner";
import { PluginReviewPanel, type PluginReview, type PolicyOutlook } from "@/components/settings/plugin-review";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PluginIcon } from "@/components/plugin-icon";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { SettingsEmpty } from "@/components/settings/shell";
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
  /** Set while an apply is in flight or was left unfinished. While it is, NONE of this
   *  plugin's connectors or skills reach a run — so the row must say so, or the plugin
   *  sits here looking normal while quietly doing nothing. */
  applyState: { status: "applying" | "failed"; kind: "install" | "upgrade" | "retry" } | null;
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

/**
 * The derived review from GET /api/extensions/review — what the update REACHES, as opposed to
 * which files it touches.
 *
 * The design (§5) has this replacing the file diff. It does not: the two answer different
 * questions — the diff "what did the author change", the review "what will this be able to do"
 * — and only the second is the decision. So the dialog ORDERS them instead: the review is the
 * body, the diff is collapsed provenance beneath it. Kept in its own state rather than inside
 * `review` because it arrives from a second request and may fail on its own without making the
 * file diff unusable.
 */
interface ReviewPayload {
  review: PluginReview;
  policies: PolicyOutlook[];
  targetSha: string;
}

/** The Extensions tab: each installed plugin shown as one unit with its skills +
 *  connectors and group-level actions (enable/disable/update/uninstall), so the
 *  pieces a plugin adds are managed together instead of scattered. */
export default function InstalledPlugins() {
  const t = useTranslations("settings.skills.installed");
  // Reuse the same "reach" wording the Library/Connectors tabs already use, so
  // shared-vs-personal reads identically everywhere in Settings > Skills.
  const tReach = useTranslations("settings.skills");
  const tReview = useTranslations("settings.skills.installed.review");
  const tState = useTranslations("settings.skills.installed.state");
  const isAdmin = useIsAdmin();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // The upgrade-review dialog: set after a preview reports real changes, so the
  // operator confirms exactly what an update brings before the pin is moved.
  const [review, setReview] = useState<{ plugin: InstalledPlugin; preview: UpgradePreview } | null>(null);
  // The derived review for the plugin in the dialog, plus the policy choices the operator
  // makes in it. Kept beside `review` rather than inside it because it arrives from a second
  // request and may fail on its own without making the file diff unusable.
  const [derived, setDerived] = useState<ReviewPayload | null>(null);
  const [dispositions, setDispositions] = useState<Record<string, "keep" | "delete">>({});

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
      if (r.ok) { if (okMsg) toast.success(okMsg); await load(); }
      else toast.error(t("actionFailed"));
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
      if (!r.ok) { toast.error(t("previewFailed")); return; }
      const preview = d as UpgradePreview;
      if (!preview.changed) { toast.success(t("upToDate")); return; }
      setReview({ plugin: p, preview });
      setDispositions({});
      setDerived(null);
      // Bound to the SAME commit the file diff describes, so the two halves of the dialog
      // cannot be about different versions.
      const rr = await fetch(`/api/extensions/review?installId=${encodeURIComponent(p.id)}&targetSha=${encodeURIComponent(preview.to.sha)}`);
      if (rr.ok) setDerived(await rr.json() as ReviewPayload);
    } catch {
      toast.error(t("previewFailed"));
    } finally {
      setBusy(null);
    }
  };

  // Step 2: apply — re-pull from source, pinning to the EXACT commit just reviewed
  // (toSha), not whatever the branch points at now (consent bound to the artifact).
  const applyUpdate = async (p: InstalledPlugin) => {
    // No fallback. The old `POST /api/extensions` path moved the pin without a reviewHash, so
    // falling back to it whenever the derived review had not loaded made the gate optional —
    // fail-OPEN on exactly the request that matters. That route now refuses, and the Apply
    // button stays disabled until a review is in hand.
    const payload = derived;
    if (!payload) return;
    setReview(null);
    setDerived(null);
    setBusy(p.id);
    try {
      const r = await fetch("/api/extensions/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installId: p.id, targetSha: payload.targetSha,
          reviewHash: payload.review.reviewHash, dispositions,
        }),
      });
      if (r.ok) { toast.success(t("updated")); await load(); return; }
      const d = await r.json().catch(() => ({})) as { error?: string; review?: PluginReview; policies?: PolicyOutlook[] };
      if (r.status === 409 && d.review) {
        // Something moved while the operator was reading. Re-open with the FRESH review the
        // server already sent — asking for it again would only widen the same window.
        toast.error(tReview(d.error === "blocked" ? "cannotApply" : "staleTitle"));
        setReview({ plugin: p, preview: { changed: true, fromSha: p.commitSha, to: { sha: payload.targetSha, date: null, message: null } } });
        setDerived({ review: d.review, policies: d.policies ?? [], targetSha: payload.targetSha });
        return;
      }
      toast.error(d.error === "failed" ? tReview("applyFailed") : t("actionFailed"));
    } catch {
      toast.error(t("actionFailed"));
    } finally {
      setBusy(null);
      await load();
    }
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
    return <SettingsEmpty icon={Package} title={t("empty")} hint={t("emptyHint")} />;
  }

  const stateVariant = (s: InstalledPlugin["enabledState"]) =>
    s === "on" ? "default" : s === "off" ? "secondary" : "outline";

  /**
   * Exhaustive, the way `scopeLabel` in the Connectors list already is — not `t(`state.${s}`)`.
   *
   * That template read fine and shipped a badge saying `settings.skills.installed.state.on`,
   * because `next-intl` renders a missing key as its own path instead of throwing, and no site
   * in the code listed the three values for a reviewer to check against the catalog. This
   * `Record` is that site: a fourth state cannot be added to the union without the compiler
   * demanding a label here.
   */
  const stateLabel: Record<InstalledPlugin["enabledState"], string> = {
    on: tState("on"), off: tState("off"), mixed: tState("mixed"),
  };

  return (
    <div className="space-y-3">
      {plugins.map((p) => {
        const title = p.displayName || p.pluginName;
        const unfinished = p.applyState?.status === "failed";
        const inFlight = p.applyState?.status === "applying";
        return (
          <div key={p.id} className="space-y-3 rounded-xl border p-4">
            {/* Above everything, because it explains why the rest of the row is inert. A
                plugin whose apply did not finish is hidden from every run, and a user
                staring at a connector that stopped answering has no other way to learn why. */}
            {unfinished && (
              <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive-text">
                <p className="font-medium">{tState("needsAttention")}</p>
                <p className="mt-1">{tState("needsAttentionBody")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {/* "Review and try again", never bare "Retry": the design requires a FRESH
                      plan, observations, baselines and hash, so there is nothing to repeat. */}
                  <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => checkUpdate(p)}>
                    {tState("reviewAndRetry")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => uninstall(p)}>
                    {t("uninstall")}
                  </Button>
                </div>
              </div>
            )}
            {inFlight && (
              <div className="flex items-start gap-2 rounded-lg bg-field p-3 text-xs text-muted-foreground">
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                <div>
                  <p className="font-medium text-foreground">
                    {tState(p.applyState?.kind === "install" ? "installing" : "applying")}
                  </p>
                  <p className="mt-0.5">{tState("applyingBody")}</p>
                </div>
              </div>
            )}
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
                  <Badge variant={stateVariant(p.enabledState)}>{stateLabel[p.enabledState]}</Badge>
                  {/* Every other tab in Settings > Skills marks shared vs personal — this
                      card was the one place that didn't, leaving members unable to tell
                      whether a plugin came from the admin or was their own install. */}
                  <Badge
                    variant="secondary"
                    className={cn("font-normal", p.scope === "system" ? "bg-success/10 text-success" : "text-muted-foreground")}
                  >
                    {p.scope === "system" ? tReach("reach.shared") : tReach("reach.personal")}
                  </Badge>
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
              {/* The derived review FIRST, because it is the thing being consented to.
                  §5 of the design has the review replacing the file diff outright; it does not,
                  and shouldn't — the diff answers "what did the author change", the review "what
                  will this be able to do", and only the second is a decision. So the two are
                  ordered rather than merged, and the diff sits under the fold below.

                  Side by side they were the same weight, and their numbers invite a comparison
                  that means nothing: "2 files changed" against "nothing changes here" is not a
                  contradiction, but it reads as one. */}
              {derived ? (
                <PluginReviewPanel
                  review={derived.review}
                  policies={derived.policies}
                  dispositions={dispositions}
                  onDisposition={(key, value) => setDispositions((d) => ({ ...d, [key]: value }))}
                />
              ) : review.preview.touchesConnectors ? (
                <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 p-2 text-xs text-warning-text">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("reviewConnectorsWarning")}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("reviewLoading")}</p>
              )}
              {/* Provenance, under the fold: the author's commit and the files it touched.
                  Collapsed because it is context for a decision already stated above, and
                  because these filenames were fetched and thrown away until now — the counts
                  line said "2 changed" and could not say which two. */}
              {(review.preview.diff || review.preview.to.message) && (
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded py-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&[data-panel-open]_.chevron]:rotate-180">
                    <ChevronDown className="chevron h-3.5 w-3.5 shrink-0 transition-transform" />
                    <span>{t("diffTitle")}</span>
                    {review.preview.diff && (
                      <span className="ml-auto tabular-nums">
                        {t("reviewChanges", {
                          added: review.preview.diff.added.length,
                          removed: review.preview.diff.removed.length,
                          modified: review.preview.diff.modified.length,
                        })}
                      </span>
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 overflow-hidden pt-1">
                    {review.preview.to.message && (
                      <p className="text-xs text-muted-foreground">{review.preview.to.message}</p>
                    )}
                    {review.preview.diff && (
                      <div className="max-h-48 space-y-2 overflow-y-auto">
                        <FileList label={t("diffAdded")} paths={review.preview.diff.added} t={t} />
                        <FileList label={t("diffModified")} paths={review.preview.diff.modified} t={t} />
                        <FileList label={t("diffRemoved")} paths={review.preview.diff.removed} t={t} />
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                {/* Disabled until the review is loaded AND applicable: consent means having
                    seen what the update reaches, so an Apply that can fire before the panel
                    renders is not a gate at all. */}
                <AlertDialogAction
                  disabled={!derived || derived.review.gate === "cannot_apply"}
                  onClick={() => applyUpdate(review.plugin)}
                >{t("reviewApply")}</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One group of the author's file changes.
 *
 * Paths, not a patch: the review above already says what the change REACHES, so the only thing
 * a filename adds is where the author was working. `break-all` because a plugin's paths are
 * long and truncating the tail hides the filename, which is the informative half.
 */
function FileList({ label, paths, t }: { label: string; paths: string[]; t: ReturnType<typeof useTranslations> }) {
  if (!paths.length) return null;
  // `previewUpgrade` does not cap the diff, and a plugin that restructured its tree can return
  // thousands of paths. Reading past the first few dozen is not how anyone uses this list, and
  // the count already stands above it — so the tail becomes a number instead of DOM nodes.
  const shown = paths.slice(0, 50);
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {shown.map((p) => (
          <li key={p} className="break-all font-mono text-[11px] text-muted-foreground">{p}</li>
        ))}
      </ul>
      {paths.length > shown.length && (
        <p className="text-[11px] text-muted-foreground">{t("diffMore", { count: paths.length - shown.length })}</p>
      )}
    </div>
  );
}
