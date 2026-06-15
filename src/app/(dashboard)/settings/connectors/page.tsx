"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plug, Plus, Trash2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

interface Server { id: string; name: string; url: string | null; scope: "system" | "user" | "project"; enabled: boolean }
type ProbeStatus = "ok" | "unauthorized" | "unreachable";
interface Health { status: ProbeStatus; toolCount?: number }

/** Mirror of the server-side slugify so the user sees the saved name live. */
function slugify(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
const looksLikeUrl = (s: string) => /^https?:\/\/.+/i.test(s.trim());

/** Site favicon for the connector's host — gives the list an App-Store feel.
 *  Loaded client-side (no server SSRF surface); falls back to the Plug glyph if
 *  the host has no favicon or the lookup fails. */
function ConnectorIcon({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  let host = "";
  try { if (url) host = new URL(url).hostname; } catch { /* not a URL */ }
  if (!host || failed) {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted">
        <Plug className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
      alt=""
      width={24}
      height={24}
      className="h-6 w-6 shrink-0 rounded"
      onError={() => setFailed(true)}
    />
  );
}

/** Friendly, localized connection status under each connector. */
function HealthLine({ h, loading, t }: { h?: Health; loading: boolean; t: ReturnType<typeof useTranslations> }) {
  if (!h) {
    return loading ? (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />{t("health.checking")}
      </span>
    ) : null;
  }
  if (h.status === "ok") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
        <CheckCircle2 className="h-3 w-3" />{t("health.ok", { count: h.toolCount ?? 0 })}
      </span>
    );
  }
  if (h.status === "unauthorized") {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
        <AlertTriangle className="h-3 w-3" />{t("health.unauthorized")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-destructive">
      <XCircle className="h-3 w-3" />{t("health.unreachable")}
    </span>
  );
}

export default function ConnectorsPage() {
  const t = useTranslations("settings.connectors");
  const [servers, setServers] = useState<Server[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [loading, setLoading] = useState(true);
  const [healthLoading, setHealthLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Health | null>(null);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch("/api/mcp/health");
      if (res.ok) setHealth((await res.json()).health ?? {});
    } finally { setHealthLoading(false); }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp");
      if (res.ok) {
        const list: Server[] = (await res.json()).servers ?? [];
        setServers(list);
        if (list.some((s) => s.enabled)) loadHealth();
      }
    } finally { setLoading(false); }
  }, [loadHealth]);
  useEffect(() => { load(); }, [load]);

  const slug = slugify(name);
  const canSubmit = slug.length > 0 && looksLikeUrl(url);

  const buildBody = () => {
    const body: Record<string, unknown> = { name: slug, url: url.trim() };
    if (token.trim()) body.headers = { Authorization: `Bearer ${token.trim()}` };
    return body;
  };

  const test = async () => {
    if (!looksLikeUrl(url)) return;
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { url: url.trim() };
      if (token.trim()) body.headers = { Authorization: `Bearer ${token.trim()}` };
      const res = await fetch("/api/mcp/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) setTestResult(await res.json());
      else setTestResult({ status: "unreachable" });
    } catch { setTestResult({ status: "unreachable" }); }
    finally { setTesting(false); }
  };

  const resetForm = () => { setName(""); setUrl(""); setToken(""); setTestResult(null); setShowForm(false); };

  const add = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBody()) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(t("added")); resetForm(); await load(); }
      else toast.error(data.error || t("addFailed"));
    } finally { setSaving(false); }
  };

  const toggle = async (id: string, enabled: boolean) => {
    const prev = servers;
    setServers((s) => s.map((x) => x.id === id ? { ...x, enabled } : x));
    const res = await fetch("/api/mcp", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
    if (!res.ok) { setServers(prev); toast.error(t("toggleFailed")); }
    else if (enabled) loadHealth();
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
          <div className="space-y-1">
            <Input placeholder={t("namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
            {name.trim() && slug && slug !== name.trim() && (
              <p className="text-xs text-muted-foreground">{t("nameHint", { slug })}</p>
            )}
          </div>
          <Input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => { setUrl(e.target.value); setTestResult(null); }} />
          <div className="space-y-1">
            <Input placeholder={t("tokenPlaceholder")} value={token} onChange={(e) => { setToken(e.target.value); setTestResult(null); }} type="password" />
            <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>
          </div>

          {testResult && (
            <div className="rounded-md bg-muted/50 px-3 py-2">
              {testResult.status === "ok"
                ? <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500"><CheckCircle2 className="h-3 w-3" />{t("testOk", { count: testResult.toolCount ?? 0 })}</span>
                : testResult.status === "unauthorized"
                  ? <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500"><AlertTriangle className="h-3 w-3" />{t("health.unauthorized")}</span>
                  : <span className="flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3 w-3" />{t("health.unreachable")}</span>}
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={saving || !canSubmit}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{t("save")}</Button>
            <Button variant="outline" size="sm" onClick={test} disabled={testing || !looksLikeUrl(url)}>{testing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{t("test")}</Button>
            <Button variant="ghost" size="sm" onClick={resetForm}>{t("cancel")}</Button>
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
          <div className="flex flex-1 items-start gap-3">
            <ConnectorIcon url={s.url} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{s.name}</span>
                <Badge variant="secondary">{scopeLabel[s.scope]}</Badge>
              </div>
              {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
              {s.enabled && <HealthLine h={health[s.id]} loading={healthLoading} t={t} />}
            </div>
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
