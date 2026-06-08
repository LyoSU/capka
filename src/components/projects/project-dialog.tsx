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
        body: JSON.stringify({ name, description, systemPrompt, defaultModel, sandboxNetwork: internetAccess ? "bridge" : "none" }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || (isEdit ? "Could not update project. Please try again." : "Could not create project. Please try again."));
        return;
      }

      const saved = await res.json();
      toast.success(isEdit ? "Project updated" : "Project created");
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      toast.error(isEdit ? "Could not update project. Please try again." : "Could not create project. Please try again.");
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
              className="min-h-16"
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
            <ModelPicker
              variant="field"
              value={defaultModel}
              onChange={setDefaultModel}
              placeholder="Use global default"
            />
            <p className="text-xs text-muted-foreground">
              Overrides the global default for chats in this project.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="sandbox-internet">Internet Access</Label>
              <p className="text-xs text-muted-foreground">
                Allow sandbox to access the internet (download files, APIs, etc.)
              </p>
            </div>
            <Switch
              id="sandbox-internet"
              checked={internetAccess}
              onCheckedChange={setInternetAccess}
            />
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
