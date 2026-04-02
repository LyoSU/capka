"use client";

import { useEffect, useState, useCallback } from "react";
import { Trash2, Plus, Loader2, Unplug, Power } from "lucide-react";
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
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

const PROVIDERS = ["openai", "anthropic", "openrouter", "ollama"] as const;
type Provider = (typeof PROVIDERS)[number];

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

  // Form state
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/providers");
      if (res.ok) setConfigs(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const resetForm = () => {
    setProvider("openai");
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
      if (!modelId) {
        toast.error("Please enter a model");
        return;
      }

      // Test connection
      const testRes = await fetch("/api/settings/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: provider !== "ollama" ? apiKey : undefined,
          modelId,
          baseUrl: provider === "ollama" ? baseUrl || "http://localhost:11434/api" : undefined,
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
          apiKey: provider !== "ollama" ? apiKey : undefined,
          baseUrl: provider === "ollama" ? baseUrl || "http://localhost:11434/api" : undefined,
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
            <p className="text-xs text-muted-foreground/60 mt-1">Add an API key to start using AI models</p>
          </div>
        )}
        {configs.map((c) => (
          <div key={c.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold capitalize">{c.provider}</span>
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
                value={c.defaultModel || ""}
                onChange={(id) => handleUpdateModel(c.id, id)}
                placeholder="Search or type model..."
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
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider !== "ollama" && (
            <div className="space-y-1.5">
              <label className="text-sm">API Key</label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>
          )}

          {provider === "ollama" && (
            <div className="space-y-1.5">
              <label className="text-sm">Base URL</label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/api"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm">Default Model</label>
            <ModelPicker
              value={defaultModel}
              onChange={setDefaultModel}
              placeholder="Search or type model..."
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
