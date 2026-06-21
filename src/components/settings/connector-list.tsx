"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plug, Plus, Trash2, CheckCircle2, AlertTriangle, XCircle, LogIn, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";

interface Server { id: string; name: string; url: string | null; scope: "system" | "user" | "project"; enabled: boolean; authKind: "token" | "oauth"; transport: "http" | "sse" | "stdio" }
type ProbeStatus = "ok" | "unauthorized" | "unreachable" | "needs_login";
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
  if (h.status === "needs_login") {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
        <LogIn className="h-3 w-3" />{t("health.needsLogin")}
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

export default function ConnectorList({ chrome = true }: { chrome?: boolean }) {
  const t = useTranslations("settings.connectors");
  const isAdmin = useIsAdmin();
  const [servers, setServers] = useState<Server[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [loading, setLoading] = useState(true);
  const [healthLoading, setHealthLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<"remote" | "local">("remote");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [envText, setEnvText] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
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

  // Surface the OAuth round-trip outcome (the callback redirects back here).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("connected")) { toast.success(t("signedIn", { name: p.get("connected") ?? "" })); }
    else if (p.get("error") === "oauth") { toast.error(t("signInFailed")); }
    if (p.get("connected") || p.get("error")) window.history.replaceState({}, "", "/settings/skills?tab=connectors");
  }, [t]);

  const slug = slugify(name);
  const isLocal = kind === "local";
  const canSubmit = slug.length > 0 && (isLocal ? command.trim().length > 0 : looksLikeUrl(url));

  // "npx -y @playwright/mcp" → command "npx", args ["-y","@playwright/mcp"].
  const parseCommand = (raw: string) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    return { command: parts[0] ?? "", args: parts.slice(1) };
  };
  // "KEY=value" per line → { KEY: "value" }.
  const parseEnv = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      if (k) out[k] = line.slice(i + 1).trim();
    }
    return out;
  };

  const buildBody = () => {
    if (isLocal) {
      const { command: cmd, args } = parseCommand(command);
      const env = parseEnv(envText);
      const body: Record<string, unknown> = { name: slug, command: cmd, args };
      if (Object.keys(env).length) body.env = env;
      return body;
    }
    const body: Record<string, unknown> = { name: slug, url: url.trim() };
    if (token.trim()) body.headers = { Authorization: `Bearer ${token.trim()}` };
    if (clientId.trim()) body.oauthClientId = clientId.trim();
    if (clientSecret.trim()) body.oauthClientSecret = clientSecret.trim();
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

  const resetForm = () => {
    setName(""); setUrl(""); setToken(""); setClientId(""); setClientSecret(""); setCommand(""); setEnvText(""); setKind("remote");
    setTestResult(null); setShowAdvanced(false); setShowForm(false);
  };

  const add = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      // Local (stdio) connectors are admin-managed and run in the sandbox.
      const endpoint = isLocal ? "/api/admin/mcp" : "/api/mcp";
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBody()) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(t("added"));
        resetForm();
        await load();
        // OAuth connector → walk the user straight into sign-in.
        if (data.authKind === "oauth" && data.id) window.location.href = `/api/mcp/oauth/start?serverId=${encodeURIComponent(data.id)}`;
      } else toast.error(data.error || t("addFailed"));
    } finally { setSaving(false); }
  };

  // Own user-scope connectors go through /api/mcp; shared (system/project) ones
  // are admin-managed via /api/admin/mcp.
  const endpointFor = (srv: Server) => (srv.scope === "user" ? "/api/mcp" : "/api/admin/mcp");
  const canManage = (srv: Server) => srv.scope === "user" || isAdmin;

  const toggle = async (srv: Server, enabled: boolean) => {
    const prev = servers;
    setServers((s) => s.map((x) => x.id === srv.id ? { ...x, enabled } : x));
    const res = await fetch(endpointFor(srv), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: srv.id, enabled }) });
    if (!res.ok) { setServers(prev); toast.error(t("toggleFailed")); }
    else if (enabled) loadHealth();
  };

  const remove = async (srv: Server) => {
    const res = await fetch(`${endpointFor(srv)}?id=${encodeURIComponent(srv.id)}`, { method: "DELETE" });
    if (res.ok) { setServers((s) => s.filter((x) => x.id !== srv.id)); toast.success(t("deleted")); }
    else toast.error(t("deleteFailed"));
  };

  const signIn = (id: string) => { window.location.href = `/api/mcp/oauth/start?serverId=${encodeURIComponent(id)}`; };

  const signOut = async (id: string) => {
    const res = await fetch(`/api/mcp/oauth?serverId=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) { toast.success(t("signedOut")); loadHealth(); }
    else toast.error(t("signOutFailed"));
  };

  const scopeLabel: Record<Server["scope"], string> = { system: t("scope.system"), user: t("scope.user"), project: t("scope.project") };

  return (
    <div className="space-y-5">
      {chrome && (
        <>
          <div>
            <h2 className="text-base font-medium">{t("title")}</h2>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <Separator />
        </>
      )}

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
          {/* Remote (URL) vs Local (sandbox command) — local is admin-only. */}
          {isAdmin && (
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-sm">
              {(["remote", "local"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setKind(k); setTestResult(null); }}
                  className={cn(
                    "rounded px-2.5 py-1 transition-colors",
                    kind === k ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(k === "remote" ? "kind.remote" : "kind.local")}
                </button>
              ))}
            </div>
          )}

          {isLocal ? (
            <div className="space-y-1">
              <Input placeholder={t("commandPlaceholder")} value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono" />
              <p className="text-xs text-muted-foreground">{t("commandHint")}</p>
              <Textarea placeholder={t("envPlaceholder")} value={envText} onChange={(e) => setEnvText(e.target.value)} className="mt-2 font-mono text-xs" rows={3} />
            </div>
          ) : (
            <>
              <Input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => { setUrl(e.target.value); setTestResult(null); }} />
              <div className="space-y-1">
                <Input placeholder={t("tokenPlaceholder")} value={token} onChange={(e) => { setToken(e.target.value); setTestResult(null); }} type="password" />
                <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>
              </div>

              <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{t("advanced")}
              </button>
              {showAdvanced && (
                <div className="space-y-2 rounded-md bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">{t("advancedHint")}</p>
                  <Input placeholder={t("clientIdPlaceholder")} value={clientId} onChange={(e) => setClientId(e.target.value)} />
                  <Input placeholder={t("clientSecretPlaceholder")} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" />
                </div>
              )}
            </>
          )}

          {testResult && (
            <div className="rounded-md bg-muted/50 px-3 py-2">
              {testResult.status === "ok"
                ? <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500"><CheckCircle2 className="h-3 w-3" />{t("testOk", { count: testResult.toolCount ?? 0 })}</span>
                : testResult.status === "needs_login"
                  ? <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500"><LogIn className="h-3 w-3" />{t("testOauth")}</span>
                  : testResult.status === "unauthorized"
                    ? <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500"><AlertTriangle className="h-3 w-3" />{t("health.unauthorized")}</span>
                    : <span className="flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3 w-3" />{t("health.unreachable")}</span>}
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={saving || !canSubmit}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{t("save")}</Button>
            {!isLocal && (
              <Button variant="outline" size="sm" onClick={test} disabled={testing || !looksLikeUrl(url)}>{testing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{t("test")}</Button>
            )}
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
      {!loading && servers.map((s) => {
        const h = health[s.id];
        const isOauth = s.authKind === "oauth";
        return (
          <div key={s.id} className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="flex flex-1 items-start gap-3">
              <ConnectorIcon url={s.url} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  <Badge variant="secondary">{scopeLabel[s.scope]}</Badge>
                  {s.transport === "stdio" && <Badge variant="outline">{t("localBadge")}</Badge>}
                </div>
                {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
                {s.transport === "stdio" && <p className="truncate text-xs text-muted-foreground">{t("localRuns")}</p>}
                {s.enabled && <HealthLine h={h} loading={healthLoading} t={t} />}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isOauth && s.enabled && (h?.status === "needs_login" || h?.status === "unauthorized") && (
                <Button size="xs" onClick={() => signIn(s.id)}><LogIn className="mr-1 h-3.5 w-3.5" />{t("signIn")}</Button>
              )}
              {isOauth && s.enabled && h?.status === "ok" && (
                <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => signOut(s.id)}>{t("signOut")}</Button>
              )}
              <Switch checked={s.enabled} disabled={!canManage(s)} onCheckedChange={(v) => toggle(s, v)} aria-label={t("toggleAria", { name: s.name })} />
              {canManage(s) && (
                <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" onClick={() => remove(s)} aria-label={t("delete")}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
