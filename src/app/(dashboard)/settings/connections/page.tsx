"use client";

import { useEffect, useState, useCallback } from "react";
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

interface ProviderConfig {
  id: string;
  provider: string;
  defaultModel: string | null;
  baseUrl: string | null;
  isActive: boolean | null;
}

export default function ConnectionsPage() {
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
      else setError("Could not load providers. Please refresh the page.");
    } catch {
      setError("Could not load providers. Please refresh the page.");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const handleActivate = async (id: string) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, activate: true }),
    });
    if (res.ok) {
      setConfigs((prev) => prev.map((c) => ({ ...c, isActive: c.id === id })));
      toast.success("Provider activated");
    } else {
      toast.error("Could not activate provider. Please try again.");
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/settings/providers?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setConfigs((prev) => prev.filter((c) => c.id !== id));
      setDeleteId(null);
      toast.success("Provider removed");
    } else {
      toast.error("Could not remove provider. Please try again.");
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
      toast.success("Default model updated");
    } else {
      toast.error("Could not update default model. Please try again.");
    }
  };

  const handleTestAndSave = async () => {
    setSaving(true);
    try {
      const modelId = defaultModel || undefined;
      if (meta.requiresKey && !apiKey) {
        toast.error("API key is required");
        return;
      }
      if (meta.requiresBaseUrl && !baseUrl) {
        toast.error("Base URL is required");
        return;
      }
      if (!modelId) {
        toast.error("Please pick a model");
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
        toast.error(`Connection failed: ${testData.error}`);
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
        toast.success("Provider saved and set as active");
        resetForm();
        fetchConfigs();
      } else {
        toast.error("Could not save provider settings. Please check your API key and try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">LLM Providers</h2>
        <p className="text-sm text-muted-foreground">
          Manage AI provider connections and API keys.
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
            <p className="text-sm text-muted-foreground">No providers connected</p>
            <p className="text-xs text-muted-foreground mt-1">Add an API key to start using AI models</p>
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
                  <Badge variant="outline" className="text-[10px]">active</Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {!c.isActive && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-primary"
                    onClick={() => handleActivate(c.id)}
                    title="Activate"
                  >
                    <Power className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteId(c.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Default Model</label>
              <ModelPicker
                variant="field"
                configId={c.id}
                value={c.defaultModel || ""}
                onChange={(id) => handleUpdateModel(c.id, id)}
                placeholder="Pick a model"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Add form */}
      {showForm ? (
        <div className="space-y-4 rounded-md border p-4">
          <div className="space-y-1.5">
            <label className="text-sm">Provider</label>
            <Select value={provider} onValueChange={(v) => changeProvider(v as ProviderName)}>
              <SelectTrigger className="w-full h-auto py-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((p) => {
                  const Icon = iconForSlug(p.iconSlug);
                  return (
                    <SelectItem key={p.value} value={p.value}>
                      <span className="flex items-center gap-2.5">
                        <Icon size={16} className="shrink-0 text-muted-foreground" />
                        <span className="flex flex-col">
                          <span className="flex items-center gap-1.5 font-medium">
                            {p.label}
                            {p.recommended && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">Recommended</span>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">{p.blurb}</span>
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
              <label className="text-sm">API Key</label>
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
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {meta.requiresBaseUrl && (
            <div className="space-y-1.5">
              <label className="text-sm">Base URL</label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={meta.baseUrlPlaceholder}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm">Model</label>
            <ModelPicker
              variant="field"
              value={defaultModel}
              onChange={setDefaultModel}
              provider={provider}
              apiKey={apiKey}
              baseUrl={baseUrl}
              disabled={(meta.requiresKey && !apiKey) || (meta.requiresBaseUrl && !baseUrl)}
              placeholder={meta.requiresKey && !apiKey ? "Enter your API key first" : "Pick a model"}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={handleTestAndSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Test &amp; Save
            </Button>
            <Button variant="ghost" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Provider
        </Button>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={() => deleteId && handleDelete(deleteId)}
        title="Remove provider?"
        description="This will disconnect the provider and remove its API key."
      />
    </div>
  );
}
