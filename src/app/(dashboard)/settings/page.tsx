"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";

export default function GeneralSettingsPage() {
  const [minContext, setMinContext] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings?key=model_min_context")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.value) setMinContext(data.value);
        else setMinContext(String(DEFAULT_MODEL_MIN_CONTEXT));
      })
      .catch(() => {});
  }, []);

  async function saveModelFilter() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "model_min_context", value: minContext }),
      });
      if (res.ok) toast.success("Saved");
      else toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const contextLabel = (val: string) => {
    const n = parseInt(val, 10);
    if (!n || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
    return `${(n / 1_000).toFixed(0)}k tokens`;
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">Appearance</h2>
        <p className="text-sm text-muted-foreground">
          Choose how unClaw looks on your device.
        </p>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Theme</label>
        <ThemeSwitcher />
      </div>

      <Separator />

      <div>
        <h2 className="text-base font-medium">Model Filter</h2>
        <p className="text-sm text-muted-foreground">
          Control which models appear in the model selector.
        </p>
      </div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Minimum context window</label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={minContext}
              onChange={(e) => setMinContext(e.target.value)}
              placeholder="100000"
              className="w-40"
            />
            <span className="text-sm text-muted-foreground">
              {contextLabel(minContext)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Models with context below this are hidden. Default: 100k.
          </p>
        </div>
        <Button size="sm" onClick={saveModelFilter} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
