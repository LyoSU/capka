"use client";

import { useEffect, useState } from "react";
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
  admin: { label: "Admin", icon: ShieldCheck, variant: "default" as const },
  user: { label: "User", icon: Shield, variant: "secondary" as const },
  viewer: { label: "Viewer", icon: Eye, variant: "outline" as const },
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => {
        if (r.status === 403) throw new Error("Admin access required");
        if (!r.ok) throw new Error("Failed to load users");
        return r.json();
      })
      .then(setUsers)
      .catch((e) => {
        const msg = e.message === "Admin access required"
          ? e.message
          : "Could not load users. Please refresh the page.";
        setError(msg);
        toast.error(e.message);
      })
      .finally(() => setLoading(false));
  }, []);

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
        toast.error(data.error || "Failed to update role");
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: data.role } : u)));
      toast.success("Role updated");
    } catch {
      toast.error("Failed to update role");
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
        <h2 className="text-lg font-semibold">Users</h2>
        <p className="text-sm text-muted-foreground">
          Manage user roles and permissions. Only admins can access this page.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-4 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">
          <span>User</span>
          <span>Email</span>
          <span>Role</span>
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
                    Admin
                  </Badge>
                )}
              </div>
              <span className="text-sm text-muted-foreground truncate">{user.email}</span>
              <Select
                value={user.role}
                onValueChange={(v) => v && updateRole(user.id, v)}
                disabled={updating === user.id}
              >
                <SelectTrigger className="w-28 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Users className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No users found</p>
          </div>
        )}
      </div>
    </div>
  );
}
