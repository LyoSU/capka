"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Shield, ShieldCheck, Eye, Users, Search, UserCheck, UserX, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SettingsEmpty, SettingsError, SettingsSkeleton, ShowMore, useShowMore } from "@/components/settings/shell";
import { UserDialog, type AdminUser, type Tier } from "./user-dialog";
import { money, relTime } from "./format";

const roleConfig = {
  admin: { icon: ShieldCheck, variant: "default" as const },
  user: { icon: Shield, variant: "secondary" as const },
  viewer: { icon: Eye, variant: "outline" as const },
};

export function PeopleTab({ initialUserId }: { initialUserId?: string | null }) {
  const t = useTranslations("settings.usersPage");
  const locale = useLocale();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user" | "viewer">("all");
  const [openId, setOpenId] = useState<string | null>(initialUserId ?? null);

  const load = useCallback(() =>
    fetch("/api/admin/users")
      .then((r) => {
        if (r.status === 403) throw new Error("forbidden");
        if (!r.ok) throw new Error("load");
        return r.json();
      })
      .then((data) => { setUsers(data.users ?? []); setTiers(data.tiers ?? []); })
      // Inline only: a load failure has to keep saying so, and a toast that says
      // the same thing three seconds longer just reports one fault twice.
      .catch((e) => setError(e.message === "forbidden" ? t("adminRequired") : t("loadError")))
      .finally(() => setLoading(false)), [t]);

  useEffect(() => { load(); }, [load]);

  const patchUser = useCallback((id: string, patch: Partial<AdminUser>) =>
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u))), []);

  const approve = async (userId: string) => {
    setUpdating(userId);
    const res = await fetch("/api/admin/users", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, status: "active" }),
    });
    setUpdating(null);
    if (res.ok) { toast.success(t("approved")); patchUser(userId, { status: "active" }); }
    else toast.error(t("actionFailed"));
  };

  const reject = async (userId: string) => {
    setUpdating(userId);
    const res = await fetch(`/api/admin/users?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    setUpdating(null);
    if (res.ok) { toast.success(t("removed")); setUsers((p) => p.filter((u) => u.id !== userId)); }
    else toast.error(t("actionFailed"));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q));
  }, [users, query]);

  const pending = filtered.filter((u) => u.status === "pending");
  const active = filtered
    .filter((u) => u.status !== "pending")
    .filter((u) => roleFilter === "all" || u.role === roleFilter);
  // Search is offered as soon as there is anyone to search: it used to appear
  // only past the seventh member, so on the instance where it was first needed
  // it had never been there before and read as a new control. The role toggles
  // keep a threshold — four buttons over three people are noise, not a filter.
  const showSearch = users.length > 0;
  const showFilters = users.length > 6;
  // Long member lists render in pages; the count restarts whenever the search or
  // the role filter changes what "the list" even means.
  const activePage = useShowMore(active, `${query}|${roleFilter}`);

  // Effective month cap for the budget bar: the user's assigned tier, else the
  // instance default tier. null → no cap → plain spend, no bar.
  const monthCapFor = (u: AdminUser): number | null => {
    const tier = tiers.find((x) => x.id === u.tierId) ?? tiers.find((x) => x.isDefault);
    const raw = tier?.limitMonth;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  if (loading) return <SettingsSkeleton rows={4} wide header={false} />;

  const openUser = users.find((u) => u.id === openId) ?? null;

  return (
    <div className="space-y-6">
      {/* The page title lives on the host page now (see users/page.tsx); this tab
          keeps only the search field that belongs beside the list. */}
      <div className="flex items-start justify-end gap-4">
        {showSearch && (
          <div className="relative w-48 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="h-9 pl-8" />
          </div>
        )}
      </div>

      {showFilters && (
        <ToggleGroup
          value={[roleFilter]}
          onValueChange={(v) => v.length && setRoleFilter(v[0] as typeof roleFilter)}
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
        >
          <ToggleGroupItem value="all">{t("filterAll")}</ToggleGroupItem>
          <ToggleGroupItem value="admin">{t("roles.admin")}</ToggleGroupItem>
          <ToggleGroupItem value="user">{t("roles.user")}</ToggleGroupItem>
          <ToggleGroupItem value="viewer">{t("roles.viewer")}</ToggleGroupItem>
        </ToggleGroup>
      )}

      {error && <SettingsError message={error} />}

      {/* Awaiting approval — the thing that needs an admin's action, up top. */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4 text-warning-text" />
            {t("pendingTitle")}
            <Badge variant="secondary" className="text-[10px]">{pending.length}</Badge>
          </div>
          <div className="overflow-hidden rounded-lg border border-warning-border bg-warning-surface/40 divide-y divide-warning-border/50">
            {pending.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{u.name || u.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" onClick={() => approve(u.id)} disabled={updating === u.id}>
                    <UserCheck className="mr-1 h-3.5 w-3.5" />{t("approve")}
                  </Button>
                  {/* Reject deletes the account outright (same endpoint as Remove in
                      the drawer), so it asks first — a misplaced click here used to
                      be unrecoverable. */}
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={updating === u.id}>
                          <UserX className="mr-1 h-3.5 w-3.5" />{t("reject")}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("rejectTitle", { name: u.name || u.email })}</AlertDialogTitle>
                        <AlertDialogDescription>{t("rejectWarn")}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => reject(u.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                          {t("reject")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active members — five zones: person · access · usage · budget · status.
          An empty list replaces the table rather than sitting inside it: a header
          row over nothing reads as "the data failed to load". */}
      {active.length === 0 ? (
        query
          ? <SettingsEmpty icon={Search} title={t("noMatches")} hint={t("noMatchesHint")} />
          : <SettingsEmpty icon={Users} title={t("empty")} hint={t("emptyHint")} />
      ) : (
      <div className="overflow-hidden rounded-lg border">
        <div className="hidden grid-cols-[1fr_9rem_5rem_9rem_6rem] items-center gap-4 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
          <span>{t("colUser")}</span>
          <span>{t("colAccess")}</span>
          <span className="text-right">{t("colUsage")}</span>
          <span>{t("colBudget")}</span>
          <span>{t("colStatus")}</span>
        </div>
        {activePage.visible.map((user) => {
          const cfg = roleConfig[user.role as keyof typeof roleConfig] || roleConfig.user;
          const Icon = cfg.icon;
          const cap = monthCapFor(user);
          const pct = cap && cap > 0 ? Math.min(999, Math.round((user.cost30d / cap) * 100)) : 0;
          return (
            <div
              key={user.id}
              role="button"
              tabIndex={0}
              onClick={() => setOpenId(user.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(user.id); } }}
              aria-label={t("openDetails", { name: user.name || user.email })}
              className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-4 border-b px-4 py-3 text-left outline-none transition-colors last:border-0 hover:bg-hover focus-visible:bg-hover sm:grid-cols-[1fr_9rem_5rem_9rem_6rem]"
            >
              {/* person */}
              <div className="flex min-w-0 items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {user.email}
                    {user.lastActivityAt ? ` · ${t("activePrefix", { when: relTime(locale, user.lastActivityAt) })}` : ""}
                  </p>
                </div>
              </div>
              {/* access */}
              <div className="hidden items-center gap-1.5 sm:flex">
                <Badge variant={cfg.variant} className="text-[10px]">{t(`roles.${user.role}`)}</Badge>
                {user.exceptionsCount > 0 && (
                  <span className="text-xs text-muted-foreground">{t("exceptionsChip", { count: user.exceptionsCount })}</span>
                )}
              </div>
              {/* usage */}
              <span className="hidden text-right text-sm tabular-nums sm:block">
                {user.turns30d > 0 ? user.turns30d : <span className="text-muted-foreground">—</span>}
              </span>
              {/* budget */}
              <div className="hidden min-w-0 sm:block">
                {cap != null ? (
                  <div className="space-y-1">
                    <div className="text-xs tabular-nums text-muted-foreground">{money(locale, user.cost30d)} / {money(locale, cap)}</div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full ${pct >= 80 ? "bg-warning-text" : "bg-primary/70"}`} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                ) : (
                  <span className="text-sm tabular-nums">{user.cost30d > 0 ? money(locale, user.cost30d) : <span className="text-muted-foreground">—</span>}</span>
                )}
              </div>
              {/* status */}
              <div>
                <Badge
                  variant={user.status === "active" ? "outline" : user.status === "suspended" ? "destructive" : "secondary"}
                  className="text-[10px]"
                >
                  {t(`statuses.${user.status}`)}
                </Badge>
              </div>
            </div>
          );
        })}
      </div>
      )}

      <ShowMore shown={activePage.visible.length} total={activePage.total} onMore={activePage.more} />

      <p className="text-xs text-muted-foreground/80">{t("spendHint")}</p>

      <UserDialog
        user={openUser}
        tiers={tiers}
        onPatch={patchUser}
        onRemoved={(id) => setUsers((p) => p.filter((u) => u.id !== id))}
        onClose={() => {
          setOpenId(null);
          // Drop the deep-link param on close, or a reload reopens a panel the
          // admin has already dismissed. replaceState, not the router: this is
          // tidying the address, not a navigation worth a history entry.
          const url = new URL(window.location.href);
          if (url.searchParams.has("user")) {
            url.searchParams.delete("user");
            window.history.replaceState(null, "", url);
          }
        }}
      />
    </div>
  );
}
