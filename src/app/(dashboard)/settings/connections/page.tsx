"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Trash2, Plus, Loader2, Unplug, Power, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ModelPicker } from "@/components/chat/model-picker";
import { iconForSlug } from "@/components/chat/provider-icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PROVIDER_OPTIONS, PROVIDER_META, providerLabel, type ProviderName } from "@/lib/providers/registry";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSetting } from "@/hooks/use-setting";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";

interface ProviderConfig {
  id: string;
  provider: string;
  defaultModel: string | null;
  baseUrl: string | null;
  isActive: boolean | null;
}

export default function ConnectionsPage() {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const isAdmin = useIsAdmin();
  const minCtx = useSetting("model_min_context", String(DEFAULT_MODEL_MIN_CONTEXT));
  const maxPrice = useSetting("model_max_price", "0");
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Form state
  const [provider, setProvider] = useState<ProviderName>("litellm");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [showKey, setShowKey] = useState(false);

  const meta = PROVIDER_META[provider];

  function changeProvider(next: ProviderName) {
    setProvider(next);
    setApiKey("");
    setDefaultModel("");
    setBaseUrl(PROVIDER_META[next].defaultBaseUrl ?? "");
  }

  const fetchConfigs = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/settings/providers");
      if (res.ok) setConfigs(await res.json());
      else setError(t("loadError"));
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const resetForm = () => {
    setProvider("litellm");
    setApiKey("");
    setBaseUrl("");
    setDefaultModel("");
    setShowForm(false);
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    if (res.ok) {
      setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, isActive: enabled } : c)));
      toast.success(enabled ? t("enabledToast") : t("disabledToast"));
    } else {
      toast.error(t("toggleError"));
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/settings/providers?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setConfigs((prev) => prev.filter((c) => c.id !== id));
      setDeleteId(null);
      toast.success(t("removed"));
    } else {
      toast.error(t("removeError"));
    }
  };

  const handleUpdateModel = async (id: string, model: string) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, defaultModel: model }),
    });
    if (res.ok) {
      setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, defaultModel: model } : c)));
      toast.success(t("modelUpdated"));
    } else {
      toast.error(t("modelUpdateError"));
    }
  };

  const handleTestAndSave = async () => {
    setSaving(true);
    try {
      const modelId = defaultModel || undefined;
      if (meta.requiresKey && !apiKey) {
        toast.error(t("keyRequired"));
        return;
      }
      if (meta.requiresBaseUrl && !baseUrl) {
        toast.error(t("baseUrlRequired"));
        return;
      }
      if (!modelId) {
        toast.error(t("pickModelError"));
        return;
      }

      const effectiveBaseUrl = meta.requiresBaseUrl ? baseUrl || meta.defaultBaseUrl : undefined;

      // Test connection
      const testRes = await fetch("/api/settings/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: meta.requiresKey ? apiKey : undefined,
          modelId,
          baseUrl: effectiveBaseUrl,
        }),
      });

      const testData = await testRes.json();
      if (!testData.success) {
        toast.error(t("connectionFailed", { error: testData.error }));
        return;
      }

      // Save
      const saveRes = await fetch("/api/settings/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: meta.requiresKey ? apiKey : undefined,
          baseUrl: effectiveBaseUrl,
          defaultModel: modelId,
        }),
      });

      if (saveRes.ok) {
        toast.success(t("saved"));
        resetForm();
        fetchConfigs();
      } else {
        toast.error(t("saveError"));
      }
    } finally {
      setSaving(false);
    }
  };

  const contextLabel = (val: string) => {
    const n = parseInt(val, 10);
    if (!n || n <= 0) return "";
    if (n >= 1_000_000) return t("tokensM", { value: (n / 1_000_000).toFixed(1) });
    return t("tokensK", { value: (n / 1_000).toFixed(0) });
  };

  const saveMinCtx = async () => {
    const ok = await minCtx.persist(minCtx.value);
    if (ok) toast.success(tc("saved"));
    else toast.error(t("minContextSaveFailed"));
  };

  const priceLabel = (val: string) => {
    const n = parseFloat(val);
    if (!n || n <= 0) return t("noPriceCap");
    return t("perMillion", { value: n % 1 === 0 ? n.toFixed(0) : n.toFixed(2) });
  };

  const saveMaxPrice = async () => {
    const ok = await maxPrice.persist(maxPrice.value);
    if (ok) toast.success(tc("saved"));
    else toast.error(t("maxPriceSaveFailed"));
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <Separator />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Provider list */}
      <div className="space-y-2">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && configs.length === 0 && !showForm && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-xl bg-muted/50 p-3 mb-3">
              <Unplug className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("emptyHint")}</p>
          </div>
        )}
        {configs.map((c) => (
          <div key={c.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = iconForSlug(PROVIDER_META[c.provider as ProviderName]?.iconSlug);
                  return <Icon size={16} className="text-muted-foreground" />;
                })()}
                <span className="text-sm font-semibold">{providerLabel(c.provider)}</span>
                {c.isActive && (
                  <Badge variant="outline" className="text-[10px]">{t("enabled")}</Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${c.isActive ? "text-primary hover:text-muted-foreground" : "text-muted-foreground hover:text-primary"}`}
                  onClick={() => handleToggle(c.id, !c.isActive)}
                  title={c.isActive ? t("disable") : t("enable")}
                  aria-pressed={!!c.isActive}
                >
                  <Power className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteId(c.id)}
                  aria-label={tc("delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("defaultModel")}</label>
              <ModelPicker
                variant="field"
                configId={c.id}
                value={c.defaultModel || ""}
                onChange={(id) => handleUpdateModel(c.id, id)}
                placeholder={t("pickModel")}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Add form */}
      {showForm ? (
        <div className="space-y-4 rounded-md border p-4">
          <div className="space-y-1.5">
            <label className="text-sm">{t("providerField")}</label>
            <Select value={provider} onValueChange={(v) => changeProvider(v as ProviderName)}>
              <SelectTrigger className="w-full h-auto py-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((p) => {
                  const Icon = iconForSlug(p.iconSlug);
                  return (
                    <SelectItem key={p.value} value={p.value} className="py-2">
                      <span className="flex items-start gap-2.5 whitespace-normal">
                        <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-1.5 font-medium">
                            {p.label}
                            {p.recommended && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{t("recommended")}</span>
                            )}
                          </span>
                          <span className="text-xs leading-snug text-muted-foreground">{p.blurb}</span>
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {meta.requiresKey && (
            <div className="space-y-1.5">
              <label className="text-sm">{t("apiKey")}</label>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? t("hideKey") : t("showKey")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {meta.requiresBaseUrl && (
            <div className="space-y-1.5">
              <label className="text-sm">{t("baseUrl")}</label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={meta.baseUrlPlaceholder}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm">{t("model")}</label>
            <ModelPicker
              variant="field"
              value={defaultModel}
              onChange={setDefaultModel}
              provider={provider}
              apiKey={apiKey}
              baseUrl={baseUrl}
              disabled={(meta.requiresKey && !apiKey) || (meta.requiresBaseUrl && !baseUrl)}
              placeholder={meta.requiresKey && !apiKey ? t("enterKeyFirst") : t("pickModel")}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={handleTestAndSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("testSave")}
            </Button>
            <Button variant="ghost" onClick={resetForm} disabled={saving}>
              {tc("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("addProvider")}
        </Button>
      )}

      {/* Model filter — global governance, admin only. Lives here because it
          shapes which models the picker offers across every connection. */}
      {isAdmin && !minCtx.loading && (
        <>
          <Separator />
          <div>
            <h2 className="text-base font-medium">{t("modelFilter")}</h2>
            <p className="text-sm text-muted-foreground">{t("modelFilterDesc")}</p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("minContext")}</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={minCtx.value}
                  onChange={(e) => minCtx.update(e.target.value)}
                  placeholder="100000"
                  className="w-40"
                />
                <span className="text-sm text-muted-foreground">
                  {contextLabel(minCtx.value)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t("minContextHint")}</p>
            </div>
            {minCtx.dirty && (
              <Button size="sm" onClick={saveMinCtx}>{tc("save")}</Button>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("maxPrice")}</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={maxPrice.value}
                  onChange={(e) => maxPrice.update(e.target.value)}
                  placeholder="25"
                  className="w-40"
                />
                <span className="text-sm text-muted-foreground">
                  {priceLabel(maxPrice.value)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t("maxPriceHint")}</p>
            </div>
            {maxPrice.dirty && (
              <Button size="sm" onClick={saveMaxPrice}>{tc("save")}</Button>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={() => deleteId && handleDelete(deleteId)}
        title={t("confirmRemoveTitle")}
        description={t("confirmRemoveDesc")}
      />
    </div>
  );
}
