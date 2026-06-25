"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Copy, Check, Send, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Mode = "open" | "approval" | "closed";
interface Config {
  telegram: { enabledToggle: boolean; ready: boolean; clientId: string; hasClientSecret: boolean; redirectUri: string };
  registrationMode: Mode;
  emailSignupEnabled: boolean;
}
interface PendingUser { id: string; name: string; email: string; status: string; createdAt: string | null }

export default function AuthenticationPage() {
  const t = useTranslations("settings.authentication");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [mode, setMode] = useState<Mode>("closed");
  const [emailSignup, setEmailSignup] = useState(true);
  const [redirectUri, setRedirectUri] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<PendingUser[]>([]);

  const loadPending = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const rows: PendingUser[] = await res.json();
      setPending(rows.filter((u) => u.status === "pending"));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/auth-config");
      if (res.ok) {
        const data: Config = await res.json();
        setEnabled(data.telegram.enabledToggle);
        setClientId(data.telegram.clientId);
        setHasSecret(data.telegram.hasClientSecret);
        setRedirectUri(data.telegram.redirectUri);
        setMode(data.registrationMode);
        setEmailSignup(data.emailSignupEnabled);
      }
      await loadPending();
    } finally {
      setLoading(false);
    }
  }, [loadPending]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { enabled, registrationMode: mode, emailSignupEnabled: emailSignup, clientId: clientId.trim() };
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      const res = await fetch("/api/admin/auth-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("saved"));
        setClientSecret("");
        await load();
      } else {
        toast.error(t("saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const copyRedirect = () => {
    navigator.clipboard.writeText(redirectUri);
    setCopied(true);
    toast.success(t("copied"));
    setTimeout(() => setCopied(false), 2000);
  };

  const approve = async (userId: string) => {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, status: "active" }),
    });
    if (res.ok) { toast.success(t("approved")); setPending((p) => p.filter((u) => u.id !== userId)); }
    else toast.error(t("actionFailed"));
  };

  const reject = async (userId: string) => {
    const res = await fetch(`/api/admin/users?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    if (res.ok) { toast.success(t("rejected")); setPending((p) => p.filter((u) => u.id !== userId)); }
    else toast.error(t("actionFailed"));
  };

  const modes: { key: Mode; }[] = [{ key: "open" }, { key: "approval" }, { key: "closed" }];
  // "Active" = toggle on AND credentials present (stored secret or a fresh one).
  const ready = enabled && !!clientId.trim() && (hasSecret || !!clientSecret.trim());

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {/* Telegram login provider */}
      <div className="space-y-4 rounded-md border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#229ED9]/10">
              <Send className="h-4.5 w-4.5 text-[#229ED9]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{t("telegram.title")}</h3>
                {enabled && (
                  <Badge variant={ready ? "secondary" : "outline"} className="text-xs">
                    {ready ? t("telegram.active") : t("telegram.incomplete")}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{t("telegram.desc")}</p>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t("telegram.toggleAria")} />
        </div>

        {enabled && (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-muted-foreground">{t("telegram.botFatherHint")}</p>
            <div className="space-y-1.5">
              <Label htmlFor="clientId">{t("telegram.clientId")}</Label>
              <Input id="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="8521897198" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clientSecret">{t("telegram.clientSecret")}</Label>
              <Input
                id="clientSecret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={hasSecret ? t("telegram.secretStored") : t("telegram.secretPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("telegram.redirectUri")}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 text-xs font-mono">{redirectUri}</code>
                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={copyRedirect}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("telegram.redirectHint")}</p>
            </div>
          </div>
        )}
      </div>

      {/* Registration mode */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t("mode.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("mode.desc")}</p>
        </div>
        <div className="grid gap-2">
          {modes.map(({ key }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                mode === key ? "border-foreground/40 bg-accent" : "hover:bg-accent/40",
              )}
            >
              <div className={cn("mt-0.5 h-4 w-4 shrink-0 rounded-full border-2", mode === key ? "border-foreground bg-foreground" : "border-muted-foreground/40")} />
              <div>
                <p className="text-sm font-medium">{t(`mode.${key}.label`)}</p>
                <p className="text-xs text-muted-foreground">{t(`mode.${key}.desc`)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Email sign-up toggle — a separate axis from the mode above. Off = no new
          email accounts; existing email users still sign in, and Telegram (if
          configured) stays open. */}
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">{t("email.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("email.desc")}</p>
          </div>
          <Switch checked={emailSignup} onCheckedChange={setEmailSignup} aria-label={t("email.toggleAria")} />
        </div>
        {!emailSignup && !ready && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-foreground">
            {t("email.deadEndWarning")}
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("save")}
        </Button>
      </div>

      {/* Pending approvals */}
      {mode === "approval" && (
        <>
          <Separator />
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{t("pending.title")}</h3>
              <p className="text-sm text-muted-foreground">{t("pending.desc")}</p>
            </div>
            {pending.length === 0 ? (
              <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">{t("pending.empty")}</p>
            ) : (
              pending.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{u.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" onClick={() => approve(u.id)}><UserCheck className="mr-1 h-3.5 w-3.5" />{t("pending.approve")}</Button>
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => reject(u.id)}>
                      <UserX className="mr-1 h-3.5 w-3.5" />{t("pending.reject")}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
