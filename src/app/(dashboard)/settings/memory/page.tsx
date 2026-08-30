"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { MemoryReview } from "@/components/settings/memory-review";
import { MemoryTopics } from "@/components/settings/memory-topics";
import {
  SettingsEmpty,
  SettingsError,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSkeleton,
} from "@/components/settings/shell";
import { parseAgentProfile, type AgentProfile } from "@/lib/agents/profile";
import type { ScopeView } from "@/lib/vault/memory-page";

/**
 * What the assistant remembers, as facts rather than as a document.
 *
 * This replaces a disabled monospace textarea holding one markdown string. That shape
 * could not carry the three relations the vault already records — which topic a fact is
 * filed under, which conversation it came from, and what it replaced — so the page threw
 * all three away, and had nowhere at all to put the facts still waiting for the reader's
 * decision. `readMemoryPage` assembles them server-side; this file is a renderer.
 *
 * Still absent, and by task rather than by oversight: the per-fact Delete (Task 2), the
 * Keep/Discard control on a waiting fact (Task 8), the topic summary (Task 9), the
 * sensitive-consent switch (Task 4) and "forget everything" (Task 13).
 */

/** One scope's contents. The user's own memory is unheaded — it is what the page is
 *  about — while a project's is a titled section, because "which project" is the thing
 *  the reader needs to know before reading a single fact under it. */
function Scope({ scope }: { scope: ScopeView }) {
  const body = (
    <>
      <MemoryTopics topics={scope.topics} />
      <MemoryReview pending={scope.pending} />
    </>
  );
  if (scope.scope === "user") return <div className="space-y-10">{body}</div>;
  return (
    <SettingsSection title={scope.projectName ?? ""}>
      <div className="space-y-10">{body}</div>
    </SettingsSection>
  );
}

export default function MemoryPage() {
  const t = useTranslations("settings.memory");
  const [scopes, setScopes] = useState<ScopeView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The user's own memory switch, plus the org ceiling that can override it. What is
  // recorded below stays VISIBLE either way: turning memory off leaves saved facts
  // alone, merely unused, so hiding them would suggest they were lost.
  // Held as a whole profile because that's what GET returns, but only the memory
  // bit is ever POSTed: the endpoint merges the patch over the stored row, so it —
  // not every caller — is what keeps the other fields from being reset by schema
  // defaults. It also refuses to write them at all (see api/me/agent-profile).
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [lockedOff, setLockedOff] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/me/agent-profile", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setProfile(parseAgentProfile(d.profile));
        setLockedOff(d.ceiling?.capabilities?.memory === false);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const toggleMemory = (checked: boolean) => {
    if (!profile) return;
    const prev = profile;
    const next: AgentProfile = { ...profile, capabilities: { ...profile.capabilities, memory: checked } };
    setProfile(next);
    fetch("/api/me/agent-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { memory: checked } }),
    })
      .then((r) => {
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

  const load = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error();
      const data: { scopes: ScopeView[] } = await res.json();
      setScopes(data.scopes ?? []);
    } catch {
      // A panel, not a toast: a page that failed to load has to keep saying so.
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <SettingsSkeleton rows={1} />;

  const nothingYet = !!scopes && scopes.every((s) => !s.topics.length && !s.pending.length);

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <SettingsGroup>
        <SettingsRow
          id="memory-enabled"
          title={t("enabled")}
          hint={lockedOff ? t("enabledLocked") : t("enabledHint")}
          disabled={lockedOff}
          onLabelClick={() => toggleMemory(!profile?.capabilities.memory)}
          control={
            <Switch
              checked={!!profile?.capabilities.memory && !lockedOff}
              disabled={lockedOff || profile === null}
              onCheckedChange={toggleMemory}
            />
          }
        />
      </SettingsGroup>

      {error ? (
        <SettingsError message={error} />
      ) : nothingYet ? (
        <SettingsEmpty title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        scopes?.map((scope) => <Scope key={scope.projectId ?? "user"} scope={scope} />)
      )}
    </SettingsPage>
  );
}
