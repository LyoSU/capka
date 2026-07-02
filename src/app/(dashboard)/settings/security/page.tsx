"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSetting } from "@/hooks/use-setting";
import { MasterKeyBanner } from "@/components/settings/master-key-banner";

export default function SecuritySettingsPage() {
  const isAdmin = useIsAdmin();
  const t = useTranslations("settings.security");

  const sandbox = useSetting("sandbox_enabled", "false");
  const sandboxNet = useSetting("sandbox_network", "none");
  const blockPrivate = useSetting("block_private_provider_urls", "false");
  const autonomy = useSetting("agent_autonomy", "supervised");

  // Deployment-level egress kill-switch, read from the controller. When false,
  // the in-app toggle has no effect (the controller downgrades bridge→none), so
  // we disable it and say why instead of letting the switch silently lie.
  // null = controller unreachable (unknown) → leave the toggle interactive.
  const [allowNetwork, setAllowNetwork] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/settings/sandbox-capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAllowNetwork(d?.allowNetwork ?? null))
      .catch(() => {});
  }, []);
  const netBlocked = allowNetwork === false;

  const loading = sandbox.loading || sandboxNet.loading || blockPrivate.loading || autonomy.loading;

  // Agent autonomy stores "supervised"/"autonomous", not a bool — map the switch.
  const toggleAutonomy = (checked: boolean) => {
    const prev = autonomy.value;
    const next = checked ? "autonomous" : "supervised";
    autonomy.update(next);
    autonomy.persist(next)
      .then((ok) => {
        if (ok) toast.success(checked ? t("autonomousEnabled") : t("autonomousDisabled"));
        else { autonomy.setValue(prev); toast.error(t("updateFailed")); }
      })
      .catch(() => { autonomy.setValue(prev); toast.error(t("updateFailed")); });
  };

  // The network setting stores "bridge"/"none", not "true"/"false".
  const toggleNet = (checked: boolean) => {
    const prev = sandboxNet.value;
    const next = checked ? "bridge" : "none";
    sandboxNet.update(next);
    sandboxNet.persist(next)
      .then((ok) => {
        if (ok) toast.success(checked ? t("netEnabled") : t("netDisabled"));
        else { sandboxNet.setValue(prev); toast.error(t("updateFailed")); }
      })
      .catch(() => { sandboxNet.setValue(prev); toast.error(t("updateFailed")); });
  };

  // Optimistic toggle with rollback — flip immediately, but restore the previous
  // value if the save fails so the UI never lies about persisted state.
  const toggle = (
    s: ReturnType<typeof useSetting>,
    key: string,
    checked: boolean,
    onMsg: string,
    offMsg: string,
  ) => {
    const prev = s.value;
    const next = checked ? "true" : "false";
    s.update(next);
    s.persist(next)
      .then((ok) => {
        if (ok) toast.success(checked ? onMsg : offMsg);
        else { s.setValue(prev); toast.error(t("updateFailed")); }
      })
      .catch(() => { s.setValue(prev); toast.error(t("updateFailed")); });
  };

  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {/* Encryption key — protects stored provider API keys */}
      <div>
        <h3 className="text-sm font-medium">{t("encryptionKey")}</h3>
        <p className="text-sm text-muted-foreground">{t("encryptionKeyDesc")}</p>
      </div>
      <MasterKeyBanner />

      <Separator />

      {/* Sandbox — isolated code execution */}
      <div>
        <h3 className="text-sm font-medium">{t("sandbox")}</h3>
        <p className="text-sm text-muted-foreground">{t("sandboxDesc")}</p>
      </div>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="pr-4">
          <p className="text-sm font-medium">{t("enableSandbox")}</p>
          <p className="text-xs text-muted-foreground">{t("enableSandboxHint")}</p>
        </div>
        <Switch
          checked={sandbox.value === "true"}
          onCheckedChange={(checked) => toggle(sandbox, "sandbox_enabled", checked, t("sandboxEnabled"), t("sandboxDisabled"))}
        />
      </div>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="pr-4">
          <p className="text-sm font-medium">{t("sandboxNet")}</p>
          <p className="text-xs text-muted-foreground">{t("sandboxNetHint")}</p>
          {netBlocked && (
            <p className="mt-1.5 text-xs font-medium text-amber-600 dark:text-amber-500">{t("sandboxNetBlocked")}</p>
          )}
        </div>
        <Switch checked={sandboxNet.value === "bridge"} onCheckedChange={toggleNet} disabled={netBlocked} />
      </div>

      <Separator />

      {/* Agent — how much the assistant may change without asking */}
      <div>
        <h3 className="text-sm font-medium">{t("agent")}</h3>
        <p className="text-sm text-muted-foreground">{t("agentDesc")}</p>
      </div>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="pr-4">
          <p className="text-sm font-medium">{t("autonomousMode")}</p>
          <p className="text-xs text-muted-foreground">{t("autonomousModeHint")}</p>
        </div>
        <Switch checked={autonomy.value === "autonomous"} onCheckedChange={toggleAutonomy} />
      </div>

      <Separator />

      {/* Network — restrict outbound provider connections */}
      <div>
        <h3 className="text-sm font-medium">{t("network")}</h3>
        <p className="text-sm text-muted-foreground">{t("networkDesc")}</p>
      </div>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="pr-4">
          <p className="text-sm font-medium">{t("blockPrivate")}</p>
          <p className="text-xs text-muted-foreground">{t("blockPrivateHint")}</p>
        </div>
        <Switch
          checked={blockPrivate.value === "true"}
          onCheckedChange={(checked) => toggle(blockPrivate, "block_private_provider_urls", checked, t("strictEnabled"), t("strictDisabled"))}
        />
      </div>
    </div>
  );
}
