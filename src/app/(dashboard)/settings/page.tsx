"use client";

import { useEffect, useState, useCallback } from "react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";

function useSetting(key: string, fallback: string) {
  const [value, setValue] = useState(fallback);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch(`/api/settings?key=${key}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.value != null) setValue(data.value);
      })
      .catch(() => {});
  }, [key]);

  const update = useCallback((v: string) => {
    setValue(v);
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      toast.success("Saved");
      setDirty(false);
    } else toast.error("Failed to save");
  }, [key, value]);

  return { value, update, save, dirty };
}

export default function GeneralSettingsPage() {
  const isAdmin = useIsAdmin();

  const minCtx = useSetting("model_min_context", String(DEFAULT_MODEL_MIN_CONTEXT));
  const sandbox = useSetting("sandbox_enabled", "false");
  const registration = useSetting("registration_enabled", "true");

  const contextLabel = (val: string) => {
    const n = parseInt(val, 10);
    if (!n || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
    return `${(n / 1_000).toFixed(0)}k tokens`;
  };

  return (
    <div className="max-w-lg space-y-6">
      {/* Theme */}
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

      {isAdmin && (
        <>
          <Separator />

          {/* Model filter — admin only */}
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
                  value={minCtx.value}
                  onChange={(e) => minCtx.update(e.target.value)}
                  placeholder="100000"
                  className="w-40"
                />
                <span className="text-sm text-muted-foreground">
                  {contextLabel(minCtx.value)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Models with context below this are hidden. Default: 100k.
              </p>
            </div>
            {minCtx.dirty && (
              <Button size="sm" onClick={minCtx.save}>Save</Button>
            )}
          </div>

          <Separator />

          {/* Sandbox — admin only */}
          <div>
            <h2 className="text-base font-medium">Sandbox</h2>
            <p className="text-sm text-muted-foreground">
              Give AI full access to a sandboxed Linux environment with Python, Node.js, and dev tools.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">Enable sandbox</p>
              <p className="text-xs text-muted-foreground">
                AI can execute commands, read/write files, and run code in an isolated container per chat.
              </p>
            </div>
            <Switch
              checked={sandbox.value === "true"}
              onCheckedChange={(checked) => {
                sandbox.update(checked ? "true" : "false");
                fetch("/api/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ key: "sandbox_enabled", value: checked ? "true" : "false" }),
                }).then((r) => {
                  if (r.ok) toast.success(checked ? "Sandbox enabled" : "Sandbox disabled");
                  else toast.error("Failed to update");
                });
              }}
            />
          </div>

          <Separator />

          {/* Registration — admin only */}
          <div>
            <h2 className="text-base font-medium">Registration</h2>
            <p className="text-sm text-muted-foreground">
              Control whether new users can create accounts.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">Allow registration</p>
              <p className="text-xs text-muted-foreground">
                When disabled, only admins can add new users. Existing users can still log in.
              </p>
            </div>
            <Switch
              checked={registration.value === "true"}
              onCheckedChange={(checked) => {
                registration.update(checked ? "true" : "false");
                fetch("/api/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ key: "registration_enabled", value: checked ? "true" : "false" }),
                }).then((r) => {
                  if (r.ok) toast.success(checked ? "Registration enabled" : "Registration disabled");
                  else toast.error("Failed to update");
                });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
