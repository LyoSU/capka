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
import type { AgentProfile } from "@/lib/agents/profile";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  defaultModel: string | null;
  sandboxNetwork: string | null;
  /** Resolved server-side (see projects/[id]/page.tsx), so this is always a
   *  COMPLETE profile — never null, never partial. Optional only because callers
   *  that don't render the settings form (the create dialog, the list) omit it. */
  agentProfile?: AgentProfile;
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

/**
 * Create-a-project dialog: name, description, and the instructions that make it a
 * project rather than a folder.
 *
 * Instructions used to be hub-only, so creating a project answered "what is it
 * called" and left "how should it behave" for a second visit to another screen —
 * which read as the form being unfinished. What stays out: the model picker (its
 * popover was clipped by the dialog's centering transform) and Agent mode (it needs
 * the org ceiling, resolved server-side on the hub page). The dialog opens straight
 * onto Settings after saving, so both are one glance away.
 */
export function ProjectDialog({ open, onOpenChange, onSaved }: ProjectDialogProps) {
  const t = useTranslations("projects");
  const tc = useTranslations("common");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setSystemPrompt("");
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
        body: JSON.stringify({ name, description, systemPrompt }),
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
                className="max-h-32 min-h-16"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-instructions">{t("form.systemPrompt")}</Label>
              <Textarea
                id="project-instructions"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t("form.systemPromptPlaceholder")}
                className="max-h-40 min-h-20"
              />
              <p className="text-xs text-muted-foreground">{t("form.systemPromptHint")}</p>
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
