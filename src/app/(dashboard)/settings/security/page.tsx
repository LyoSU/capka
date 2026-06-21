"use client";

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
  const blockPrivate = useSetting("block_private_provider_urls", "false");

  const loading = sandbox.loading || blockPrivate.loading;

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
