"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Shield, ShieldCheck, Eye, Loader2, Users, Search, Trash2, UserCheck, UserX, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  createdAt: string | null;
  cost30d: number;
};

const roleConfig = {
  admin: { icon: ShieldCheck, variant: "default" as const },
  user: { icon: Shield, variant: "secondary" as const },
  viewer: { icon: Eye, variant: "outline" as const },
};

export default function UsersPage() {
  const t = useTranslations("settings.usersPage");
  const locale = useLocale();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user" | "viewer">("all");

  const load = useCallback(() =>
    fetch("/api/admin/users")
      .then((r) => {
        if (r.status === 403) throw new Error("forbidden");
        if (!r.ok) throw new Error("load");
        return r.json();
      })
      .then(setUsers)
      .catch((e) => {
        const forbidden = e.message === "forbidden";
        setError(forbidden ? t("adminRequired") : t("loadError"));
        toast.error(forbidden ? t("adminRequired") : t("loadFailed"));
      })
      .finally(() => setLoading(false)), [t]);

  useEffect(() => { load(); }, [load]);

  const updateRole = async (userId: string, role: string) => {
    setUpdating(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("roleUpdateFailed")); return; }
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: data.role } : u)));
      toast.success(t("roleUpdated"));
    } catch { toast.error(t("roleUpdateFailed")); }
    finally { setUpdating(null); }
  };

  const approve = async (userId: string) => {
    setUpdating(userId);
    const res = await fetch("/api/admin/users", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, status: "active" }),
    });
    setUpdating(null);
    if (res.ok) { toast.success(t("approved")); setUsers((p) => p.map((u) => (u.id === userId ? { ...u, status: "active" } : u))); }
    else toast.error(t("actionFailed"));
  };

  const remove = async (userId: string) => {
    setUpdating(userId);
    const res = await fetch(`/api/admin/users?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    setUpdating(null);
    if (res.ok) { toast.success(t("removed")); setUsers((p) => p.filter((u) => u.id !== userId)); }
    else toast.error(t("actionFailed"));
  };

  const money = (n: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n || 0);
  const joined = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q));
  }, [users, query]);

  const pending = filtered.filter((u) => u.status === "pending");
  const active = filtered
    .filter((u) => u.status !== "pending")
    .filter((u) => roleFilter === "all" || u.role === roleFilter);
  const showFilters = users.length > 6;

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {showFilters && (
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

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

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
                  <p className="truncate text-xs text-muted-foreground">{u.email} · {t("requestedOn", { date: joined(u.createdAt) })}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" onClick={() => approve(u.id)} disabled={updating === u.id}>
                    <UserCheck className="mr-1 h-3.5 w-3.5" />{t("approve")}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => remove(u.id)} disabled={updating === u.id}>
                    <UserX className="mr-1 h-3.5 w-3.5" />{t("reject")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active members */}
      <div className="overflow-hidden rounded-lg border">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid-cols-[1fr_7rem_6rem_auto]">
          <span>{t("colUser")}</span>
          <span className="hidden text-right sm:block">{t("colSpend")}</span>
          <span className="hidden sm:block">{t("colRole")}</span>
          <span className="text-right">{t("colActions")}</span>
        </div>
        {active.map((user) => {
          const cfg = roleConfig[user.role as keyof typeof roleConfig] || roleConfig.user;
          const Icon = cfg.icon;
          return (
            <div key={user.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b px-4 py-3 last:border-0 sm:grid-cols-[1fr_7rem_6rem_auto]">
              <div className="flex min-w-0 items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}{user.createdAt ? ` · ${t("joined", { date: joined(user.createdAt) })}` : ""}</p>
                </div>
              </div>
              <span className="hidden text-right text-sm tabular-nums sm:block">
                {user.cost30d > 0 ? money(user.cost30d) : <span className="text-muted-foreground">—</span>}
              </span>
              <Select
                value={user.role}
                onValueChange={(v) => v && updateRole(user.id, v)}
                disabled={updating === user.id}
                items={{ admin: t("roles.admin"), user: t("roles.user"), viewer: t("roles.viewer") }}
              >
                <SelectTrigger className="h-8 w-full text-xs sm:w-28" aria-label={t("changeRole")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                  <SelectItem value="user">{t("roles.user")}</SelectItem>
                  <SelectItem value="viewer">{t("roles.viewer")}</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex justify-end">
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={t("remove")} disabled={updating === user.id}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("removeTitle", { name: user.name || user.email })}</AlertDialogTitle>
                      <AlertDialogDescription>{t("removeWarn")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => remove(user.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                        {t("remove")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          );
        })}
        {active.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Users className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{query ? t("noMatches") : t("empty")}</p>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground/80">{t("spendHint")}</p>
    </div>
  );
}
