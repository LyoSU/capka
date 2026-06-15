"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

interface Skill {
  id: string;
  name: string;
  description: string | null;
  scope: "system" | "user" | "project";
  enabled: boolean;
}

export default function SkillsPage() {
  const t = useTranslations("settings.skills");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchSkills = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/skills");
      if (res.ok) setSkills((await res.json()).skills ?? []);
      else setError(t("loadError"));
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = async (id: string, enabled: boolean) => {
    const prev = skills;
    setSkills((s) => s.map((x) => (x.id === id ? { ...x, enabled } : x)));
    const res = await fetch("/api/skills", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    if (!res.ok) {
      setSkills(prev); // rollback
      toast.error(t("toggleFailed"));
    }
  };

  const scopeLabel: Record<Skill["scope"], string> = {
    system: t("scope.system"),
    user: t("scope.user"),
    project: t("scope.project"),
  };

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

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && skills.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <Sparkles className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      )}

      {!loading &&
        skills.map((s) => (
          <div key={s.id} className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{s.name}</span>
                <Badge variant="secondary">{scopeLabel[s.scope]}</Badge>
              </div>
              {s.description && <p className="text-sm text-muted-foreground">{s.description}</p>}
            </div>
            <Switch
              checked={s.enabled}
              disabled={s.scope !== "user"}
              onCheckedChange={(v) => toggle(s.id, v)}
              aria-label={t("toggleAria", { name: s.name })}
            />
          </div>
        ))}
    </div>
  );
}
