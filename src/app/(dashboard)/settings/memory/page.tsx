"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SettingsPage, SettingsSection, SettingsGroup, SettingsRow } from "@/components/settings/shell";
import { parseAgentProfile, type AgentProfile } from "@/lib/agents/profile";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

interface ProjectDoc {
  id: string;
  name: string;
  content: string;
}

/** One editable memory document (the user-global doc or a project's). Tracks its
 *  own dirty/saving state so saving one doesn't disturb another. */
function DocEditor({
  value,
  projectId,
  onSaved,
}: {
  value: string;
  projectId: string | null;
  onSaved: (content: string) => void;
}) {
  const t = useTranslations("settings.memory");
  const tc = useTranslations("common");
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  // Reset when the underlying doc switches (e.g. picking another project).
  useEffect(() => setDraft(value), [value]);

  const dirty = draft !== value;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/memory-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, projectId }),
      });
      if (!res.ok) throw new Error();
      onSaved(draft);
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("placeholder")}
        className="min-h-40 font-mono text-sm"
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {tc("save")}
        </Button>
      </div>
    </div>
  );
}

export default function MemoryPage() {
  const t = useTranslations("settings.memory");
  const [userDoc, setUserDoc] = useState("");
  const [projectDocs, setProjectDocs] = useState<ProjectDoc[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The user's own memory switch, plus the org ceiling that can override it. The
  // docs below stay visible and editable either way: turning memory off leaves
  // saved notes alone (merely unused), so hiding them would suggest they were lost.
  // The WHOLE profile is held, not just the one bit shown. The endpoint replaces
  // the stored object, so posting `{capabilities:{memory}}` would let the schema
  // defaults quietly reset every other field — invisible today, when memory is the
  // only user-level switch, and a silent data loss the day a second one ships.
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
      body: JSON.stringify(next),
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
      const res = await fetch("/api/memory-docs");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setUserDoc(data.user ?? "");
      setProjectDocs(data.projects ?? []);
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = projectDocs.find((p) => p.id === selectedProject) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

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

      <SettingsSection title={t("userTitle")} description={t("userDesc")}>
        <DocEditor value={userDoc} projectId={null} onSaved={setUserDoc} />
      </SettingsSection>

      {projectDocs.length > 0 && (
        <SettingsSection title={t("projectTitle")} description={t("projectDesc")}>
          <Select
            value={selectedProject ?? ""}
            onValueChange={(v) => setSelectedProject(v || null)}
            items={projectDocs.map((p) => ({ value: p.id, label: p.name }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("selectProject")} />
            </SelectTrigger>
            <SelectContent>
              {projectDocs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <DocEditor
              key={selected.id}
              value={selected.content}
              projectId={selected.id}
              onSaved={(content) =>
                setProjectDocs((prev) => prev.map((p) => (p.id === selected.id ? { ...p, content } : p)))
              }
            />
          )}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
