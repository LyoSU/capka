"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useIsAdmin } from "@/hooks/use-is-admin";

interface Skill {
  id: string;
  name: string;
  description: string | null;
  scope: "system" | "user" | "project";
  enabled: boolean;
}

export default function SkillsPage() {
  const t = useTranslations("settings.skills");
  const isAdmin = useIsAdmin();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("scope", "system"); // admin upload = org-wide
      const res = await fetch("/api/admin/skills", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(t("addSuccess", { name: data.name ?? "" }));
        await fetchSkills();
      } else {
        toast.error(data.error || t("addFailed"));
      }
    } catch {
      toast.error(t("addFailed"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

      {isAdmin && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-dashed p-4">
          <div>
            <p className="text-sm font-medium">{t("addTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("addHint")}</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
            {t("add")}
          </Button>
        </div>
      )}

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
