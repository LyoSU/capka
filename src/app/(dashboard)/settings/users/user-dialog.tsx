"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Loader2, ChevronRight, Trash2 } from "lucide-react";
import { explainPolicy } from "@/lib/governance/matcher";
import type { PolicyInfo, CapabilityType } from "@/lib/governance/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
import { EffectBadge } from "@/components/shared/effect-badge";
import { ChartTooltip } from "@/components/shared/chart-tooltip";

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
  workload: { chats: number; projects: number; lastChatAt: string | null };
  series: { day: string; cost: number; calls: number }[];
};

const DEFAULT_TIER = "__default__";

export function UserDialog({
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
  const [securityOpen, setSecurityOpen] = useState(false);

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
      if (!res.ok) { toast.error(t("actionFailed")); return false; }
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
  // "Instance default" and the tier literally named "Default" looked like the
  // same option twice. They are not: one FOLLOWS whichever tier is currently the
  // default (and moves when an admin changes it), the other pins this person to
  // that tier by name. Saying which one it follows right now is what makes the
  // difference visible.
  const defaultTierName = tiers.find((x) => x.isDefault)?.name;
  const defaultTierLabel = defaultTierName
    ? t("defaultTierNamed", { name: defaultTierName })
    : t("defaultTier");
  // The default tier is marked in the list too, so pinning it by name reads as a
  // deliberate choice rather than a duplicate of the option above it.
  const tierItemLabel = (x: Tier) => (x.isDefault ? t("tierIsDefault", { name: x.name }) : x.name);
  const windowLabel: Record<WindowKey, string> = { h5: t("window5h"), d7: t("window7d"), d30: t("window30d") };

  // The facts an admin reads but never acts on — when they joined, when they were
  // last around, whether Telegram is linked — used to be three label/value rows
  // each, competing with the two controls that actually do something. One dim
  // line under the name says the same thing and takes a quarter of the space.
  // Telegram appears only when it IS linked: "not connected" is the norm and
  // stating the norm on every card is noise.
  const meta = [
    shown.lastActivityAt ? t("activePrefix", { when: relTime(locale, shown.lastActivityAt) }) : t("never"),
    shortDate(locale, shown.createdAt) ? `${t("joinedLabel")}: ${shortDate(locale, shown.createdAt)}` : null,
    shown.telegramConnected ? "Telegram" : null,
  ].filter(Boolean).join(" · ");

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      {/* One card, two columns: who they are and what they may do on the left,
          what they spent on the right. At sm:max-w-lg in a side panel this was a
          single column two screens tall, so the tier control and the spend it
          governs could never be read together. */}
      <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="gap-1 border-b px-4 py-3 pr-12">
          <DialogTitle className="truncate">{shown.name || shown.email}</DialogTitle>
          <DialogDescription className="truncate">{shown.email}</DialogDescription>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </DialogHeader>

        {/* scrollbar-gutter keeps the reserved track out of the numbers on the
            right edge instead of overlapping them once the card overflows. */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]">
          {/* Two columns, one question each: what an admin CHANGES about this
              person, and what they came to READ. Both are the same plain
              label-on-the-left row, with nothing boxed inside a card that is
              already a card — a frame around three rows inside a dialog was one
              border too many, and every extra frame is another level of hierarchy
              the eye has to resolve before finding the tier control. */}
          <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-1">
            <GroupTitle>{t("accessTitle")}</GroupTitle>
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
            <Field label={t("tierLabel")}>
              {/* With one tier configured — the shipped default, on most instances
                  — a picker offers "follow the default" and that same tier by name:
                  two options with identical effect and no way to tell them apart.
                  There is nothing to choose until a second tier exists, so it says
                  what applies instead of asking. */}
              {/* Localized, not the row's name: the shipped tier is called
                  "Default" by a migration, so on a Ukrainian instance that name is
                  an English word we put there ourselves — and with one tier it
                  identifies nothing anyway. Once an admin has created tiers of
                  their own, their names show as written. */}
              {tiers.length < 2 ? (
                <span className="text-sm text-muted-foreground">{t("defaultTier")}</span>
              ) : (
                <Select
                  value={tierValue}
                  onValueChange={(v) => v && v !== tierValue && mutate({ tierId: v === DEFAULT_TIER ? null : v }, { tierId: v === DEFAULT_TIER ? null : v }, t("tierUpdated"))}
                  disabled={busy}
                  items={Object.fromEntries([[DEFAULT_TIER, defaultTierLabel], ...tiers.map((x) => [x.id, tierItemLabel(x)])])}
                >
                  <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("tierLabel")}>
                    <SelectValue className="truncate" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_TIER}>{defaultTierLabel}</SelectItem>
                    {tiers.map((x) => <SelectItem key={x.id} value={x.id}>{tierItemLabel(x)}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </Field>
            {/* How much of the instance they use, counted — not what they talk
                about. Titles would have told an admin the subject of every
                conversation the chat route deliberately refuses them. */}
            {detail && detail.workload.chats > 0 && (
              <Field label={t("workloadLabel")}>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t("workloadValue", { chats: detail.workload.chats, projects: detail.workload.projects })}
                </span>
              </Field>
            )}

            {exceptions.length === 0 ? (
              <p className="pt-3 text-xs text-muted-foreground">{t("noExceptions")}</p>
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
                        <EffectBadge effect={effect} label={t(`effects.${effect}`)} />
                        <span className="text-xs text-muted-foreground">{t(`scopeWon.${win?.scope ?? "user"}`)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Usage — the same rows as the left column, so the two read as one card
              rather than as a settings panel beside a dashboard. The turn counts
              were a pair of bordered tiles; as rows they line up with the spend
              above them and lose two more frames. */}
          <section className="space-y-1">
            <GroupTitle>{t("usageTitle")}</GroupTitle>
            {loading && !detail ? (
              <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : detail ? (
              <>
                {detail.windows.map((w) => (
                  <div key={w.window}>
                    <Field label={windowLabel[w.window]}>
                      <span className="text-sm tabular-nums">
                        {money(locale, w.used)}
                        {w.limit != null && <span className="text-muted-foreground"> / {money(locale, w.limit)}</span>}
                      </span>
                    </Field>
                    {w.limit != null && <Bar pct={w.pct} />}
                  </div>
                ))}
                <Sparkline series={detail.series} days={30} locale={locale} t={t} />
                <Field label={t("turnsCompleted")}>
                  <span className="text-sm tabular-nums">{detail.completed}</span>
                </Field>
                <Field label={t("turnsFailed")}>
                  {/* Stays a number. Linking it would have led into someone else's
                      chat — a 404 for the admin, and a promise the product does
                      not keep. Failures worth investigating are on the Activity
                      page, which is written for an admin to read. */}
                  <span className={`text-sm tabular-nums ${detail.failed > 0 ? "text-warning-text" : ""}`}>{detail.failed}</span>
                </Field>
                {detail.topModels.map((m) => (
                  <Field key={m.model} label={m.model}>
                    <span className="text-sm tabular-nums text-muted-foreground">{money(locale, m.cost)}</span>
                  </Field>
                ))}
                <Link
                  href={`/settings/usage?userId=${encodeURIComponent(shown.id)}`}
                  className="inline-block pt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t("openUsage")}
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("detailUnavailable")}</p>
            )}
          </section>
          </div>

          <Separator />

          {/* Security & history — collapsed, and spanning both columns rather than
              hanging off the bottom of one: as the tail of the right-hand column it
              left the card's floor ragged and made the sessions list read as part
              of the spend above it. Who signed in from which browser, and who
              changed what when, is what an admin opens during an incident — not on
              the visit where they change somebody's tier. */}
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setSecurityOpen((v) => !v)}
              aria-expanded={securityOpen}
              className="flex w-full items-center gap-1.5 text-left text-sm font-medium"
            >
              <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${securityOpen ? "rotate-90" : ""}`} />
              {t("securityTitle")}
            </button>
            {securityOpen && (
              <div className="space-y-3 pt-1">
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
                    <p className="text-xs text-muted-foreground">{t("historyTitle")}</p>
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
              </div>
            )}
          </section>
        </div>

        {/* Acting on the person, pinned where actions live — not at the bottom of
            a scroll that has to be travelled first. */}
        <div className="flex shrink-0 flex-wrap gap-2 border-t px-4 py-3">
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
      </DialogContent>
    </Dialog>
  );
}

// A label/value row. `min-h-8` holds one rhythm whether the value is plain text,
// a badge or a select, and the label is the part that gives way when space runs
// short — a clipped control (the tier name losing its last letters) reads as a
// rendering bug, a shortened label doesn't.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm text-muted-foreground">{label}</span>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-medium">{children}</h3>;
}

/**
 * Thirty days of spend as one line.
 *
 * The three window figures say what was spent; they can't say whether it is
 * climbing. Days with no spend are absent from the query (grouping returns only
 * days that exist), so the series is re-laid onto a full calendar first —
 * otherwise a quiet week would compress into a straight line and read as steady
 * use. Renders nothing when there is no spend at all: a flat line at zero is a
 * chart that says less than the empty space it occupies.
 */
function Sparkline({ series, days, locale, t }: { series: { day: string; cost: number; calls: number }[]; days: number; locale: string; t: ReturnType<typeof useTranslations> }) {
  const [hover, setHover] = useState<number | null>(null);
  const byDay = new Map(series.map((p) => [p.day, p]));
  const today = new Date();
  const points = Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const found = byDay.get(day);
    return { day, cost: found?.cost ?? 0, calls: found?.calls ?? 0 };
  });
  const max = Math.max(...points.map((p) => p.cost));
  if (max <= 0) return null;

  const w = 100;
  const h = 24;
  const step = w / Math.max(1, points.length - 1);
  const line = points.map((p, i) => `${(i * step).toFixed(2)},${(h - (p.cost / max) * h).toFixed(2)}`).join(" ");
  const active = hover != null ? points[hover] : null;

  return (
    // Hover reads the pointer's x against the box, so every pixel of the strip
    // belongs to the nearest day — a 3px-wide invisible target per point would be
    // a chart you have to aim at.
    <div
      className="relative h-6 w-full"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - r.left) / r.width;
        setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-primary/60" />
      </svg>
      {/* The marker and rule live in the HTML layer, not the SVG: the chart
          stretches to its container with preserveAspectRatio="none", which scales
          x and y unequally — a <circle> in there comes out an ellipse. Only the
          polyline can survive that (its stroke is width-corrected); anything meant
          to keep its shape has to be positioned in percentages outside it. */}
      {active && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-border"
            style={{ left: `${(hover! / (points.length - 1)) * 100}%` }}
          />
          <div
            className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
            style={{
              left: `${(hover! / (points.length - 1)) * 100}%`,
              top: `${(1 - active.cost / max) * 100}%`,
            }}
          />
          <ChartTooltip pos={hover! / (points.length - 1)}>
            <span className="tabular-nums">{money(locale, active.cost)}</span>
            <span className="ml-1.5 tabular-nums text-muted-foreground">{t("callsN", { count: active.calls })}</span>
            <span className="ml-1.5 text-muted-foreground">{shortDate(locale, active.day)}</span>
          </ChartTooltip>
        </>
      )}
    </div>
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
