"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Lock } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ASSISTANT_PROFILE, RAW_PROFILE, CAPABILITY_GROUPS, presetOf, type AgentProfile,
} from "@/lib/agents/profile";
import { cn } from "@/lib/utils";

/**
 * "Agent mode" — a capability allow-list plus prompt composition. ONE component
 * for both levels it exists at (a project's own profile, and the org-wide ceiling
 * on Settings → Security), because the two are the same shape with the same
 * semantics; a second implementation would be two places to drift.
 *
 * Two audiences in one section, on purpose. The PRESET is a single plain-language
 * choice anyone can make. The per-group switches underneath are admin-only, like
 * the reasoning/cache fields in the (i) popover: a knob a non-technical colleague
 * has no use for shouldn't be in their way — but on a one-person install the sole
 * user IS the admin and sees everything.
 *
 * The preset is DERIVED from the profile (`presetOf`), never stored beside it, so
 * a label can't end up describing something the profile no longer is.
 */
export function AgentModeSection({
  profile, onChange, isAdmin, hasInstructions, ceiling, scope = "project",
}: {
  profile: AgentProfile;
  onChange: (p: AgentProfile) => void;
  isAdmin?: boolean;
  /** Whether instructions exist at this level — the project's own, or the org-wide
   *  ones. Drives the "you'll get no system prompt at all" warning. */
  hasInstructions: boolean;
  /** The org ceiling this level is clamped by (`resolveAgentProfile`). Anything it
   *  forbids is shown locked rather than as a switch that saves and does nothing —
   *  same honesty rule as the deployment-blocked "Internet access" toggle. Omitted
   *  at org scope, which IS the ceiling. */
  ceiling?: AgentProfile;
  scope?: "project" | "org";
}) {
  const t = useTranslations("projects.form.agent");
  const [open, setOpen] = useState(false);
  const preset = presetOf(profile);
  // A group is locked when the ceiling forbids it; the same for the two prompt
  // switches, where "restrictive" means replace / no session context.
  const lockedGroup = (g: (typeof CAPABILITY_GROUPS)[number]) => ceiling ? !ceiling.capabilities[g] : false;
  const personaLocked = ceiling?.persona === "replace";
  const sessionLocked = ceiling ? !ceiling.sessionContext : false;
  const anyLocked = CAPABILITY_GROUPS.some(lockedGroup) || personaLocked || sessionLocked;

  return (
    // Same card shape as SettingsGroup (rounded-xl / bg-card): this section sits
    // directly under one on both pages that use it, and a slightly different
    // radius on adjacent cards is the kind of mismatch you feel before you see.
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="space-y-0.5">
        <Label>{t("label")}</Label>
        <p className="text-xs text-muted-foreground">{t(scope === "org" ? "hintOrg" : `hint.${preset}`)}</p>
      </div>

      <div className="inline-flex rounded-lg border bg-muted/40 p-1">
        {([
          { key: "assistant", value: ASSISTANT_PROFILE },
          { key: "raw", value: RAW_PROFILE },
        ] as const).map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              preset === p.key ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`preset.${p.key}`)}
          </button>
        ))}
        {/* Not selectable — it's a readout of "this profile matches no preset",
            shown only while that's true, so the control never lies about state. */}
        {preset === "custom" && (
          <span className="rounded-md bg-card px-3 py-1.5 text-sm font-medium shadow-sm">{t("preset.custom")}</span>
        )}
      </div>

      {/* The honest consequence of a raw prompt with nothing written in it: the
          model gets no system message at all. Better seen now than inferred later.
          At org scope it's a narrower claim — a project can still supply its own
          text — so it speaks only about chats that have none. */}
      {profile.persona === "replace" && !hasInstructions && (
        <p className="text-xs text-warning-text">{t(scope === "org" ? "rawEmptyOrg" : "rawEmpty")}</p>
      )}

      {/* Says WHY a switch below is immovable, so a capped project doesn't read as
          a broken one. Only when something is actually capped. */}
      {anyLocked && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          {t("cappedByAdmin")}
        </p>
      )}

      {isAdmin && (
        <div className="border-t pt-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={open}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
            {t("advanced")}
          </button>

          {open && (
            <div className="mt-3 space-y-2.5">
              {CAPABILITY_GROUPS.map((g) => (
                <label key={g} className={cn("flex items-center justify-between gap-3 text-sm", lockedGroup(g) && "text-muted-foreground")}>
                  <span>{t(`cap.${g}`)}</span>
                  <Switch
                    checked={profile.capabilities[g] && !lockedGroup(g)}
                    disabled={lockedGroup(g)}
                    onCheckedChange={(v) =>
                      onChange({ ...profile, capabilities: { ...profile.capabilities, [g]: v } })
                    }
                  />
                </label>
              ))}
              <div className="space-y-2.5 border-t pt-2.5">
                <label className={cn("flex items-center justify-between gap-3 text-sm", personaLocked && "text-muted-foreground")}>
                  <span>{t("persona")}</span>
                  <Switch
                    checked={profile.persona === "replace" || personaLocked}
                    disabled={personaLocked}
                    onCheckedChange={(v) => onChange({ ...profile, persona: v ? "replace" : "append" })}
                  />
                </label>
                <label className={cn("flex items-center justify-between gap-3 text-sm", sessionLocked && "text-muted-foreground")}>
                  <span>{t("sessionContext")}</span>
                  <Switch
                    checked={profile.sessionContext && !sessionLocked}
                    disabled={sessionLocked}
                    onCheckedChange={(v) => onChange({ ...profile, sessionContext: v })}
                  />
                </label>
              </div>
              <p className="pt-1 text-xs text-muted-foreground">{t(scope === "org" ? "advancedNoteOrg" : "advancedNote")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
