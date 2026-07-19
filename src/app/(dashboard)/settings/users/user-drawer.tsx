"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Loader2, Send, Monitor, ShieldAlert, History, Trash2 } from "lucide-react";
import { explainPolicy } from "@/lib/governance/matcher";
import type { PolicyInfo, CapabilityType } from "@/lib/governance/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { money, shortDate, relTime } from "./format";

export type Tier = {
  id: string;
  name: string;
  limit5h: string | null;
  limitWeek: string | null;
  limitMonth: string | null;
  isDefault: boolean | null;
};

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  createdAt: string | null;
  cost30d: number;
  lastActivityAt: string | null;
  turns30d: number;
  exceptionsCount: number;
  tierId: string | null;
  telegramConnected: boolean;
};

type WindowKey = "h5" | "d7" | "d30";
type Detail = {
  tierName: string;
  windows: { window: WindowKey; used: number; limit: number | null; pct: number }[];
  completed: number;
  failed: number;
  topModels: { model: string; cost: number; calls: number }[];
  sessions: { id: string; createdAt: string | null; updatedAt: string | null; ipAddress: string | null; userAgent: string | null }[];
};

const DEFAULT_TIER = "__default__";

export function UserDrawer({
  user, tiers, onPatch, onRemoved, onClose,
}: {
  user: AdminUser | null;
  tiers: Tier[];
  onPatch: (id: string, patch: Partial<AdminUser>) => void;
  onRemoved: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("settings.usersPage");
  const locale = useLocale();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [policies, setPolicies] = useState<PolicyInfo[]>([]);
  const [audit, setAudit] = useState<{ id: string; action: string; createdAt: string | null; actorName: string | null; detail: Record<string, unknown> }[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Retain the last opened user so the sheet keeps its content while it animates
  // OUT (the parent drops `user` to null on close; unmounting immediately would
  // kill base-ui's exit transition and flash the panel away).
  const [shown, setShown] = useState<AdminUser | null>(user);
  useEffect(() => { if (user) setShown(user); }, [user]);

  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    setDetail(null);
    Promise.all([
      fetch(`/api/admin/users?detail=${encodeURIComponent(userId)}`).then((r) => (r.ok ? r.json() : null)),
      // Effective-permission exceptions. Defensive: the policies response may not
      // carry userId yet (parallel change) — then no exception can be attributed.
      fetch("/api/admin/policies").then((r) => (r.ok ? r.json() : { policies: [] })).catch(() => ({ policies: [] })),
      // THIS user's audit history, filtered in SQL — a recent-events window fished
      // client-side goes blank once busier accounts push past it.
      fetch(`/api/admin/audit?targetType=user&targetKey=${encodeURIComponent(userId)}&limit=50`).then((r) => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] })),
    ])
      .then(([d, p, a]) => {
        setDetail(d);
        setPolicies(Array.isArray(p?.policies) ? p.policies : []);
        setAudit(a?.entries ?? []);
      })
      .finally(() => setLoading(false));
  }, [userId]);

  const mutate = useCallback(async (body: Record<string, unknown>, patch: Partial<AdminUser>, okMsg: string) => {
    if (!userId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t("actionFailed")); return false; }
      onPatch(userId, patch);
      toast.success(okMsg);
      return true;
    } catch { toast.error(t("actionFailed")); return false; }
    finally { setBusy(false); }
  }, [userId, onPatch, t]);

  const remove = async () => {
    if (!userId) return;
    setBusy(true);
    const res = await fetch(`/api/admin/users?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) { toast.success(t("removed")); onRemoved(userId); onClose(); }
    else toast.error(t("actionFailed"));
  };

  const revokeSessions = async () => {
    const ok = await mutate({ revokeSessions: true }, {}, t("sessionsRevoked"));
    if (ok && userId) fetch(`/api/admin/users?detail=${encodeURIComponent(userId)}`).then((r) => r.ok && r.json()).then((d) => d && setDetail(d));
  };

  if (!shown) return null;

  const exceptions = policies.filter((p) => p.scope === "user" && p.userId === shown.id);
  // Rows visible to this user (org + own) so explainPolicy resolves the winner.
  const visibleRows = policies.filter((p) => p.scope === "system" || (p.scope === "user" && p.userId === shown.id));
  const tierValue = shown.tierId && tiers.some((x) => x.id === shown.tierId) ? shown.tierId : DEFAULT_TIER;
  const windowLabel: Record<WindowKey, string> = { h5: t("window5h"), d7: t("window7d"), d30: t("window30d") };

  return (
    <Sheet open={!!user} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md" side="right">
        <SheetHeader className="gap-1">
          <SheetTitle className="truncate">{shown.name || shown.email}</SheetTitle>
          <SheetDescription className="truncate">{shown.email}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-8">
          {/* Overview */}
          <section className="space-y-3">
            <Field label={t("drawerStatus")}>
              <StatusBadge status={shown.status} t={t} />
            </Field>
            <Field label={t("colRole")}>
              <Select
                value={shown.role}
                onValueChange={(v) => v && v !== shown.role && mutate({ role: v }, { role: v }, t("roleUpdated"))}
                disabled={busy}
                items={{ admin: t("roles.admin"), user: t("roles.user"), viewer: t("roles.viewer") }}
              >
                <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("changeRole")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                  <SelectItem value="user">{t("roles.user")}</SelectItem>
                  <SelectItem value="viewer">{t("roles.viewer")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("lastActivity")}>
              <span className="text-sm">{shown.lastActivityAt ? relTime(locale, shown.lastActivityAt) : <span className="text-muted-foreground">{t("never")}</span>}</span>
            </Field>
            <Field label="Telegram">
              <span className="flex items-center gap-1.5 text-sm">
                <Send className="h-3.5 w-3.5 text-muted-foreground" />
                {shown.telegramConnected ? t("tgConnected") : <span className="text-muted-foreground">{t("tgNotConnected")}</span>}
              </span>
            </Field>
            <Field label={t("joinedLabel")}>
              <span className="text-sm">{shortDate(locale, shown.createdAt) || "—"}</span>
            </Field>
          </section>

          <Separator />

          {/* Access */}
          <section className="space-y-3">
            <GroupTitle icon={ShieldAlert}>{t("accessTitle")}</GroupTitle>
            {exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noExceptions")}</p>
            ) : (
              <ul className="space-y-1.5">
                {exceptions.map((ex) => {
                  const win = explainPolicy(visibleRows, ex.capabilityType as CapabilityType, ex.capabilityKey);
                  const effect = win?.effect ?? ex.effect;
                  return (
                    <li key={ex.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground">{t(`capType.${ex.capabilityType}`)} · </span>
                        {ex.capabilityKey}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <EffectBadge effect={effect} t={t} />
                        <span className="text-xs text-muted-foreground">{t(`scopeWon.${win?.scope ?? "user"}`)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <Field label={t("tierLabel")}>
              <Select
                value={tierValue}
                onValueChange={(v) => v && v !== tierValue && mutate({ tierId: v === DEFAULT_TIER ? null : v }, { tierId: v === DEFAULT_TIER ? null : v }, t("tierUpdated"))}
                disabled={busy}
                items={Object.fromEntries([[DEFAULT_TIER, t("defaultTier")], ...tiers.map((x) => [x.id, x.name])])}
              >
                <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("tierLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_TIER}>{t("defaultTier")}</SelectItem>
                  {tiers.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </section>

          <Separator />

          {/* Usage */}
          <section className="space-y-3">
            <GroupTitle>{t("usageTitle")}</GroupTitle>
            {loading && !detail ? (
              <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : detail ? (
              <>
                <div className="space-y-2">
                  {detail.windows.map((w) => (
                    <div key={w.window} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{windowLabel[w.window]}</span>
                        <span className="tabular-nums">
                          {money(locale, w.used)}
                          {w.limit != null && <span className="text-muted-foreground"> / {money(locale, w.limit)}</span>}
                        </span>
                      </div>
                      {w.limit != null && <Bar pct={w.pct} />}
                    </div>
                  ))}
                </div>
                <div className="flex gap-4 text-sm">
                  <span>{t("turnsCompleted")}: <span className="font-medium tabular-nums">{detail.completed}</span></span>
                  <span>{t("turnsFailed")}: <span className="font-medium tabular-nums">{detail.failed}</span></span>
                </div>
                {detail.topModels.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{t("topModels")}</p>
                    <ul className="space-y-1">
                      {detail.topModels.map((m) => (
                        <li key={m.model} className="flex justify-between gap-2 text-xs">
                          <span className="min-w-0 truncate">{m.model}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{money(locale, m.cost)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("detailUnavailable")}</p>
            )}
          </section>

          <Separator />

          {/* Security & history */}
          <section className="space-y-3">
            <GroupTitle icon={Monitor}>{t("securityTitle")}</GroupTitle>
            {detail && detail.sessions.length > 0 ? (
              <>
                <ul className="space-y-1.5">
                  {detail.sessions.map((s) => (
                    <li key={s.id} className="rounded-lg border px-3 py-2 text-xs">
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{t("sessionSeen", { when: relTime(locale, s.updatedAt) })}</span>
                        <span className="tabular-nums text-muted-foreground">{shortDate(locale, s.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-muted-foreground/80">{[s.ipAddress, uaSummary(s.userAgent)].filter(Boolean).join(" · ") || t("sessionUnknown")}</p>
                    </li>
                  ))}
                </ul>
                <Button variant="outline" size="sm" onClick={revokeSessions} disabled={busy}>{t("revokeAll")}</Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noSessions")}</p>
            )}

            {audit.length > 0 && (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><History className="h-3.5 w-3.5" />{t("historyTitle")}</p>
                <ul className="space-y-1">
                  {audit.slice(0, 8).map((e) => (
                    <li key={e.id} className="flex justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">{historyLabel(e.action, e.detail, t)}{e.actorName ? ` — ${e.actorName}` : ""}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{shortDate(locale, e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Separator />

            <div className="flex flex-wrap gap-2">
              {shown.status === "suspended" ? (
                <Button variant="outline" size="sm" onClick={() => mutate({ status: "active" }, { status: "active" }, t("reactivated"))} disabled={busy}>
                  {t("reactivate")}
                </Button>
              ) : (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="outline" size="sm" className="text-warning-text hover:text-warning-text" disabled={busy}>{t("suspend")}</Button>} />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("suspendTitle", { name: shown.name || shown.email })}</AlertDialogTitle>
                      <AlertDialogDescription>{t("suspendWarn")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => mutate({ status: "suspended" }, { status: "suspended" }, t("suspended"))}>{t("suspend")}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}

              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy}><Trash2 className="mr-1 h-3.5 w-3.5" />{t("remove")}</Button>} />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("removeTitle", { name: shown.name || shown.email })}</AlertDialogTitle>
                    <AlertDialogDescription>{t("removeWarn")}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={remove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t("remove")}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function GroupTitle({ icon: Icon, children }: { icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-sm font-medium">
      {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      {children}
    </h3>
  );
}

function Bar({ pct }: { pct: number }) {
  const over80 = pct >= 80;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full ${over80 ? "bg-warning-text" : "bg-primary/70"}`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

function StatusBadge({ status, t }: { status: string; t: ReturnType<typeof useTranslations> }) {
  const known = status === "active" || status === "pending" || status === "suspended" || status === "rejected";
  const variant = status === "active" ? "outline" : status === "suspended" ? "destructive" : "secondary";
  return <Badge variant={variant} className="text-[11px]">{known ? t(`statuses.${status}`) : status}</Badge>;
}

function EffectBadge({ effect, t }: { effect: string; t: ReturnType<typeof useTranslations> }) {
  const known = effect === "allow" || effect === "deny" || effect === "ask";
  const variant = effect === "allow" ? "outline" : effect === "deny" ? "destructive" : "secondary";
  return <Badge variant={variant} className="text-[10px]">{known ? t(`effects.${effect}`) : effect}</Badge>;
}

// A calm, localized one-liner for an audit row, derived from the action + detail.
// (The generic Activity page renders the raw action label; here we tailor it to
// the person view — e.g. a status_change reads as "Suspended" / "Reactivated".)
function historyLabel(action: string, detail: Record<string, unknown>, t: ReturnType<typeof useTranslations>): string {
  if (action === "user.suspend") return t("hSuspended");
  if (action === "user.reactivate") return t("hReactivated");
  if (action === "user.sessions_revoke") return t("hSessionsRevoked");
  if (action === "user.tier_change") return t("hTierChanged");
  if (action === "user.status_change") {
    // Older rows predate the dedicated suspend/reactivate actions; read the detail.
    if (detail?.event === "sessions_revoked") return t("hSessionsRevoked");
    const s = detail?.status;
    if (s === "suspended") return t("hSuspended");
    if (s === "active") return t("hReactivated");
    if (s === "pending") return t("hSetPending");
    return t("hStatusChanged");
  }
  if (action === "user.role_change") return t("hRoleChanged");
  if (action === "user.remove") return t("hRemoved");
  if (action === "billing.update") return t("hTierChanged");
  return action;
}

// Collapse a user-agent into a short, human "Chrome on macOS"-ish label without a
// parser lib — enough for an admin to recognize a device, not forensic detail.
function uaSummary(ua: string | null): string {
  if (!ua) return "";
  const browser = /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /(iPhone|iPad)/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ");
}
