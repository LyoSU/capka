"use client";

import { useState, useEffect } from "react";
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
  createdAt: string | null;
  updatedAt: string | null;
};

interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  onSaved?: (project: Project) => void;
}

export function ProjectDialog({ open, onOpenChange, project, onSaved }: ProjectDialogProps) {
  const isEdit = !!project;
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultModel, setDefaultModel] = useState("");

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description ?? "");
      setSystemPrompt(project.systemPrompt ?? "");
      setDefaultModel(project.defaultModel ?? "");
    } else {
      setName("");
      setDescription("");
      setSystemPrompt("");
      setDefaultModel("");
    }
  }, [project, open]);

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }

    setSaving(true);
    try {
      const url = isEdit ? `/api/projects/${project.id}` : "/api/projects";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, systemPrompt, defaultModel }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save project");
        return;
      }

      const saved = await res.json();
      toast.success(isEdit ? "Project updated" : "Project created");
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      toast.error("Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Project" : "New Project"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update project settings." : "Create a new project to organize your chats."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description..."
              className="min-h-12"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-system-prompt">System Prompt</Label>
            <Textarea
              id="project-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Custom instructions for this project..."
              className="min-h-20 font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-default-model">Default Model</Label>
            <Input
              id="project-default-model"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder="e.g. openai:gpt-5.2"
            />
            <p className="text-xs text-muted-foreground">
              Overrides the global default for chats in this project.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
