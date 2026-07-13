"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
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
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">{t("userTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("userDesc")}</p>
        </div>
        <DocEditor value={userDoc} projectId={null} onSaved={setUserDoc} />
      </section>

      {projectDocs.length > 0 && (
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">{t("projectTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("projectDesc")}</p>
          </div>
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
        </section>
      )}
    </div>
  );
}
