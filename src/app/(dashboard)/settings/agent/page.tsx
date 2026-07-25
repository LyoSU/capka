"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsPage, SettingsSection, SettingsGroup, SettingsRow, SettingsSkeleton } from "@/components/settings/shell";
import { AgentModeSection } from "@/components/settings/agent-mode";
import { useSetting } from "@/hooks/use-setting";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { CAPABILITY_GROUPS, parseAgentProfile, type AgentProfile } from "@/lib/agents/profile";

/**
 * Settings → Agent: what the assistant IS, instance-wide.
 *
 * Split out of Settings → Security, where all of this used to live. That page
 * promises to protect keys, isolate code, and restrict outbound connections —
 * "which persona does the agent have" is a different question, and mixing the two
 * left the same switch (the sandbox capability) appearing twice under a comment
 * apologising for it. Perimeter stayed on Security; identity moved here.
 */
export default function AgentSettingsPage() {
  const t = useTranslations("settings.agent");
  const tc = useTranslations("common");
  const isAdmin = useIsAdmin();
  const autonomy = useSetting("agent_autonomy", "supervised");
  const instructions = useSetting("agent_instructions", "");

  // The org ceiling. Not a `useSetting` key — one validated object behind its own
  // endpoint (see /api/settings/agent-profile). null = still loading.
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/settings/agent-profile", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setProfile(parseAgentProfile(d)))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // A capability the admin is about to REMOVE from everyone waits for a yes. Held
  // as the pending profile rather than a boolean so the dialog's confirm applies
  // exactly the change that was described, with no second derivation of it.
  const [pending, setPending] = useState<AgentProfile | null>(null);

  const requestProfile = (next: AgentProfile) => {
    const removes = CAPABILITY_GROUPS.some((g) => profile?.capabilities[g] && !next.capabilities[g]);
    if (removes) setPending(next);
    else saveProfile(next);
  };

  // Optimistic with rollback: a switch that waits for a round-trip before moving
  // reads as broken, and a switch that moves and silently fails is worse.
  const saveProfile = (next: AgentProfile) => {
    const prev = profile;
    setProfile(next);
    fetch("/api/settings/agent-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    })
      .then((r) => {
        // Success is silent — the switch itself is the receipt. See the same choice
        // on the Security page.
        if (!r.ok) {
          setProfile(prev);
          toast.error(t("saveFailed"));
        }
      })
      .catch(() => {
        setProfile(prev);
        toast.error(t("saveFailed"));
      });
  };

  const toggleAutonomy = (checked: boolean) => {
    const prev = autonomy.value;
    const next = checked ? "autonomous" : "supervised";
    autonomy.setValue(next);
    autonomy
      .persist(next)
      .then((ok) => {
        if (!ok) {
          autonomy.setValue(prev);
          toast.error(t("saveFailed"));
        }
      })
      .catch(() => {
        autonomy.setValue(prev);
        toast.error(t("saveFailed"));
      });
  };

  // Instructions are the one field here with an explicit Save, so it is the one
  // place a half-written change can be lost. Guard the browser-level exits; an
  // in-app route change still loses it, which is why the Save button stays
  // prominent rather than hiding until hover.
  useEffect(() => {
    if (!instructions.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [instructions.dirty]);

  const saveInstructions = async () => {
    const ok = await instructions.persist(instructions.value);
    if (ok) toast.success(t("saved"));
    else toast.error(t("saveFailed"));
  };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;

  if (profile === null || autonomy.loading || instructions.loading) {
    return <SettingsSkeleton rows={2} />;
  }

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <SettingsSection title={t("instructions.title")} description={t("instructions.desc")} footnote={t("instructions.note")}>
        <Textarea
          id="agent-instructions"
          value={instructions.value}
          onChange={(e) => instructions.update(e.target.value)}
          placeholder={t("instructions.placeholder")}
          className="min-h-32 scroll-mt-24"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={saveInstructions} disabled={!instructions.dirty}>
            {tc("save")}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t("abilities.title")} description={t("abilities.desc")}>
        <SettingsGroup>
          {/* The ceiling's `sandbox` bit, shown as its own row as well as inside the
              mode section's advanced list. Two views of one value, not two values:
              this is the switch an admin comes here looking for. */}
          <SettingsRow
            id="sandbox-enabled"
            title={t("abilities.sandbox")}
            hint={t("abilities.sandboxHint")}
            onLabelClick={() =>
              requestProfile({ ...profile, capabilities: { ...profile.capabilities, sandbox: !profile.capabilities.sandbox } })
            }
            control={
              <Switch
                checked={profile.capabilities.sandbox}
                onCheckedChange={(checked) =>
                  requestProfile({ ...profile, capabilities: { ...profile.capabilities, sandbox: checked } })
                }
              />
            }
          />
          <SettingsRow
            id="agent-autonomy"
            title={t("autonomy.title")}
            hint={t("autonomy.hint")}
            onLabelClick={() => toggleAutonomy(autonomy.value !== "autonomous")}
            control={<Switch checked={autonomy.value === "autonomous"} onCheckedChange={toggleAutonomy} />}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("mode.title")} description={t("mode.desc")}>
        <div id="agent-mode" className="scroll-mt-24">
          <AgentModeSection
            scope="org"
            profile={profile}
            onChange={requestProfile}
            isAdmin
            hasInstructions={!!instructions.value.trim()}
          />
        </div>
      </SettingsSection>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmOff.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmOff.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) saveProfile(pending);
                setPending(null);
              }}
            >
              {t("confirmOff.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}
