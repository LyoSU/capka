"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);

  const fetchProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  function handleCreate() {
    setEditProject(null);
    setDialogOpen(true);
  }

  function handleEdit(project: Project) {
    setEditProject(project);
    setDialogOpen(true);
  }

  async function handleDelete(project: Project) {
    if (!confirm(`Delete "${project.name}"? Chats will be kept but unlinked.`)) return;

    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to delete project");
        return;
      }
      toast.success("Project deleted");
      fetchProjects();
    } catch {
      toast.error("Something went wrong");
    }
  }

  function handleSaved() {
    fetchProjects();
  }

  function formatDate(d: string | null) {
    if (!d) return "";
    return new Date(d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Organize your chats with custom instructions and models.
          </p>
        </div>
        <Button size="sm" onClick={handleCreate}>
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-3 mb-3">
            <MessageSquare className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            No projects yet. Create one to organize your chats.
          </p>
          <Button size="sm" variant="outline" onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            Create Project
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((project) => (
            <Card key={project.id} size="sm">
              <CardHeader>
                <CardTitle>
                  <Link
                    href={`/chat?projectId=${project.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {project.name}
                  </Link>
                </CardTitle>
                {project.description && (
                  <CardDescription className="line-clamp-2">
                    {project.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {project.defaultModel && (
                    <span className="truncate max-w-[140px]">{project.defaultModel}</span>
                  )}
                  {project.systemPrompt && (
                    <span>Custom prompt</span>
                  )}
                </div>
              </CardContent>
              <CardFooter className="justify-between">
                <span className="text-xs text-muted-foreground">
                  {formatDate(project.updatedAt)}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleEdit(project)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleDelete(project)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={editProject}
        onSaved={handleSaved}
      />
    </div>
  );
}
