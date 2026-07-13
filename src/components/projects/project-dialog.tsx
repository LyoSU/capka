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
  // caller (e.g. the create dialog) has them.
  chatCount?: number;
  lastChatAt?: string | null;
};

interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (project: Project) => void;
}

/** Create-a-project dialog — deliberately just name + description. Everything
 *  else (instructions, model, internet, deletion) lives in the hub's Settings
 *  tab, where a full page gives the model picker room a modal can't (the
 *  dialog's centering transform + overflow clipping used to cut it off). */
export function ProjectDialog({ open, onOpenChange, onSaved }: ProjectDialogProps) {
  const t = useTranslations("projects");
  const tc = useTranslations("common");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t("createError"));
        return;
      }

      const saved = await res.json();
      toast.success(t("created"));
      // Nudge the sidebar's Projects section to refresh.
      window.dispatchEvent(new Event("projects:changed"));
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      toast.error(t("createError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* `contents` keeps the header/body/footer as direct grid rows of the
            dialog while still giving the fields a real <form> (Enter submits). */}
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{t("new")}</DialogTitle>
            <DialogDescription>{t("createDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">{t("form.name")}</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("form.namePlaceholder")}
                autoFocus
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
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? tc("saving") : tc("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
