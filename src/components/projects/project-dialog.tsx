"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ModelPicker } from "@/components/chat/model-picker";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  defaultModel: string | null;
  sandboxNetwork: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  // Aggregates from GET /api/projects (non-archived chats). Optional — not every
  // caller (e.g. the create/edit dialog) has them.
  chatCount?: number;
  lastChatAt?: string | null;
};

interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  onSaved?: (project: Project) => void;
}

export function ProjectDialog({ open, onOpenChange, project, onSaved }: ProjectDialogProps) {
  const t = useTranslations("projects");
  const tc = useTranslations("common");
  const isEdit = !!project;
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [internetAccess, setInternetAccess] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description ?? "");
      setSystemPrompt(project.systemPrompt ?? "");
      setDefaultModel(project.defaultModel ?? "");
      setInternetAccess(project.sandboxNetwork === "bridge");
    } else {
      setName("");
      setDescription("");
      setSystemPrompt("");
      setDefaultModel("");
      setInternetAccess(false);
    }
  }, [project, open]);

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }

    setSaving(true);
    try {
      const url = isEdit ? `/api/projects/${project.id}` : "/api/projects";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, systemPrompt, defaultModel, sandboxNetwork: internetAccess ? "bridge" : "none" }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || (isEdit ? t("updateError") : t("createError")));
        return;
      }

      const saved = await res.json();
      toast.success(isEdit ? t("updated") : t("created"));
      // Nudge the sidebar's Projects section to refresh (create/rename/settings).
      window.dispatchEvent(new Event("projects:changed"));
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      toast.error(isEdit ? t("updateError") : t("createError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("editTitle") : t("new")}</DialogTitle>
          <DialogDescription>
            {isEdit ? t("editDesc") : t("createDesc")}
          </DialogDescription>
        </DialogHeader>

        {/* -mx-4 px-4 lets the scrollbar sit at the modal edge while the fields
            keep their padding (and their focus rings aren't clipped); min-h-0
            lets this region shrink below its content so it — not the whole
            modal — scrolls once a long system prompt outgrows the viewport. */}
        <div className="-mx-4 min-h-0 space-y-4 overflow-y-auto px-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">{t("form.name")}</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("form.namePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-description">{t("form.description")}</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("form.descriptionPlaceholder")}
              className="max-h-40 min-h-16"
            />
          </div>

          {/* Instructions, model and internet are advanced settings — kept out of
              the create form (which is just name + description, so a first-time
              user isn't confronted with jargon) and shown only when editing an
              existing project from its hub Settings. */}
          {isEdit && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="project-system-prompt">{t("form.systemPrompt")}</Label>
                <Textarea
                  id="project-system-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder={t("form.systemPromptPlaceholder")}
                  className="max-h-[50vh] min-h-24 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="project-default-model">{t("form.defaultModel")}</Label>
                <ModelPicker
                  variant="field"
                  value={defaultModel}
                  onChange={setDefaultModel}
                  placeholder={t("form.useGlobalDefault")}
                  clearable
                />
                <p className="text-xs text-muted-foreground">
                  {t("form.defaultModelHint")}
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="sandbox-internet">{t("form.internet")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("form.internetHint")}
                  </p>
                </div>
                <Switch
                  id="sandbox-internet"
                  checked={internetAccess}
                  onCheckedChange={setInternetAccess}
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tc("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? tc("saving") : isEdit ? tc("save") : tc("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
