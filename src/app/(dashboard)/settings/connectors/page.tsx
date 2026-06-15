"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

interface Server { id: string; name: string; url: string | null; scope: "system" | "user" | "project"; enabled: boolean }

export default function ConnectorsPage() {
  const t = useTranslations("settings.connectors");
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp");
      if (res.ok) setServers((await res.json()).servers ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name, url };
      if (token.trim()) body.headers = { Authorization: `Bearer ${token.trim()}` };
      const res = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(t("added")); setName(""); setUrl(""); setToken(""); setShowForm(false); await load(); }
      else toast.error(data.error || t("addFailed"));
    } finally { setSaving(false); }
  };

  const toggle = async (id: string, enabled: boolean) => {
    const prev = servers;
    setServers((s) => s.map((x) => x.id === id ? { ...x, enabled } : x));
    const res = await fetch("/api/mcp", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
    if (!res.ok) { setServers(prev); toast.error(t("toggleFailed")); }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/mcp?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) { setServers((s) => s.filter((x) => x.id !== id)); toast.success(t("deleted")); }
    else toast.error(t("deleteFailed"));
  };

  const scopeLabel: Record<Server["scope"], string> = { system: t("scope.system"), user: t("scope.user"), project: t("scope.project") };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      <div className="flex justify-end">
        {!showForm && <Button variant="outline" size="sm" onClick={() => setShowForm(true)}><Plus className="mr-1.5 h-4 w-4" />{t("add")}</Button>}
      </div>

      {showForm && (
        <div className="space-y-3 rounded-md border p-4">
          <Input placeholder={t("namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder={t("tokenPlaceholder")} value={token} onChange={(e) => setToken(e.target.value)} type="password" />
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{t("save")}</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {loading && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
      {!loading && servers.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <Plug className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      )}
      {!loading && servers.map((s) => (
        <div key={s.id} className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{s.name}</span>
              <Badge variant="secondary">{scopeLabel[s.scope]}</Badge>
            </div>
            {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Switch checked={s.enabled} disabled={s.scope !== "user"} onCheckedChange={(v) => toggle(s.id, v)} aria-label={t("toggleAria", { name: s.name })} />
            {s.scope === "user" && (
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" onClick={() => remove(s.id)} aria-label={t("delete")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
