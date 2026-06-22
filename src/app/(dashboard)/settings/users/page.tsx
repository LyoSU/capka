"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Shield, ShieldCheck, Eye, Loader2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string | null;
};

const roleConfig = {
  admin: { icon: ShieldCheck, variant: "default" as const },
  user: { icon: Shield, variant: "secondary" as const },
  viewer: { icon: Eye, variant: "outline" as const },
};

export default function UsersPage() {
  const t = useTranslations("settings.usersPage");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
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
      .finally(() => setLoading(false));
  }, [t]);

  const updateRole = async (userId: string, role: string) => {
    setUpdating(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t("roleUpdateFailed"));
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: data.role } : u)));
      toast.success(t("roleUpdated"));
    } catch {
      toast.error(t("roleUpdateFailed"));
    } finally {
      setUpdating(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-4 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">
          <span>{t("colUser")}</span>
          <span>{t("colEmail")}</span>
          <span>{t("colRole")}</span>
        </div>
        {users.map((user) => {
          const cfg = roleConfig[user.role as keyof typeof roleConfig] || roleConfig.user;
          return (
            <div
              key={user.id}
              className="grid grid-cols-[1fr_1fr_auto] items-center gap-4 border-b px-4 py-3 last:border-0"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{user.name}</span>
                {user.role === "admin" && (
                  <Badge variant={cfg.variant} className="text-[10px] px-1.5 py-0">
                    {t("roles.admin")}
                  </Badge>
                )}
              </div>
              <span className="text-sm text-muted-foreground truncate">{user.email}</span>
              <Select
                value={user.role}
                onValueChange={(v) => v && updateRole(user.id, v)}
                disabled={updating === user.id}
                items={{ admin: t("roles.admin"), user: t("roles.user"), viewer: t("roles.viewer") }}
              >
                <SelectTrigger className="w-28 h-8 text-xs" aria-label={t("changeRole")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                  <SelectItem value="user">{t("roles.user")}</SelectItem>
                  <SelectItem value="viewer">{t("roles.viewer")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Users className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
