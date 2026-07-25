"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSetting } from "@/hooks/use-setting";
import { MasterKeyBanner } from "@/components/settings/master-key-banner";
import { SettingsPage, SettingsSection, SettingsGroup, SettingsRow } from "@/components/settings/shell";
import { cn } from "@/lib/utils";

/**
 * Settings → Security: the PERIMETER only — the stored-key encryption, what the
 * sandbox may reach on the network, and which folders may be handed to it.
 *
 * What the agent is allowed to BE (capabilities, persona, autonomy, the org-wide
 * instructions) moved to Settings → Agent. Keeping both here meant one page
 * answered two unrelated questions, and the sandbox capability had to appear
 * twice to serve both readings.
 */
export default function SecuritySettingsPage() {
  const isAdmin = useIsAdmin();
  const t = useTranslations("settings.security");

  // NOTE: the agent capability switches are NOT here any more (see Settings →
  // Agent). This page reads only perimeter keys.
  const sandboxNet = useSetting("sandbox_network", "none");
  const blockPrivate = useSetting("block_private_provider_urls", "false");
  const hostFolders = useSetting("host_folder_access", "false");
  const pcFolders = useSetting("pc_folder_access", "off");

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

  // Everything on this page except the encryption key and the provider-URL rule
  // exists to fence in the SANDBOX. With the sandbox off there is nothing to fence,
  // so those controls are not disabled here — they're absent. A switch that can't
  // matter is still something to read, decide about, and be unsure of; the place it
  // comes back from is one click away under Settings → Agent.
  const [sandboxOn, setSandboxOn] = useState<boolean | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/settings/agent-profile", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      // Unknown (request failed) shows the controls rather than hiding them: a
      // blank page is a worse answer than one extra row.
      .then((d) => setSandboxOn(d?.capabilities?.sandbox ?? true))
      .catch(() => setSandboxOn(true));
    return () => ac.abort();
  }, []);

  const loading = sandboxNet.loading || blockPrivate.loading || hostFolders.loading || pcFolders.loading || sandboxOn === null;

  // Optimistic with rollback — flip immediately, but restore the previous value if
  // the save fails so the UI never lies about persisted state. Shared by every
  // control here, including the tri-state one, which is why it takes the raw value.
  const save = (s: ReturnType<typeof useSetting>, next: string) => {
    const prev = s.value;
    if (next === prev) return;
    s.update(next);
    s.persist(next)
      .then((ok) => {
        if (ok) toast.success(t("updated"));
        else {
          s.setValue(prev);
          toast.error(t("updateFailed"));
        }
      })
      .catch(() => {
        s.setValue(prev);
        toast.error(t("updateFailed"));
      });
  };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <SettingsSection title={t("encryptionKey")} description={t("encryptionKeyDesc")}>
        <MasterKeyBanner />
      </SettingsSection>

      <SettingsSection title={t("network")} description={t("networkDesc")} footnote={t("networkNote")}>
        <SettingsGroup>
          {sandboxOn && (
            <SettingsRow
              id="sandbox-network"
              title={t("sandboxNet")}
              hint={t("sandboxNetHint")}
              warning={netBlocked ? t("sandboxNetBlocked") : undefined}
              disabled={netBlocked}
              control={
                <Switch
                  checked={sandboxNet.value === "bridge"}
                  disabled={netBlocked}
                  onCheckedChange={(checked) => save(sandboxNet, checked ? "bridge" : "none")}
                />
              }
            />
          )}
          <SettingsRow
            id="block-private-urls"
            title={t("blockPrivate")}
            hint={t("blockPrivateHint")}
            control={
              <Switch
                checked={blockPrivate.value === "true"}
                onCheckedChange={(checked) => save(blockPrivate, String(checked))}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {sandboxOn && (
      <SettingsSection title={t("folders")} description={t("foldersDesc")}>
        <SettingsGroup>
          <SettingsRow
            id="host-folders"
            title={t("hostFolders")}
            hint={t("hostFoldersHint")}
            control={
              <Switch
                checked={hostFolders.value === "true"}
                onCheckedChange={(checked) => save(hostFolders, String(checked))}
              />
            }
          />
          <SettingsRow id="pc-folders" title={t("pcFolders")} hint={t("pcFoldersHint")}>
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
              {(["off", "admins", "everyone"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => save(pcFolders, opt)}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    pcFolders.value === opt
                      ? "bg-card shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`folder_${opt}`)}
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      )}
    </SettingsPage>
  );
}
