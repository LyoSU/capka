"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Plus, Pencil, Trash2, FolderKanban } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { displayModelName } from "@/lib/providers/registry";

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

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
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(t("deleteError"));
        return;
      }
      toast.success(t("deleted"));
      setDeleteTarget(null);
      fetchProjects();
    } catch {
      toast.error(t("deleteError"));
    }
  }

  function handleSaved() {
    fetchProjects();
  }

  function formatDate(d: string | null) {
    if (!d) return "";
    return new Date(d).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  return (
    <div className="animate-fade-in mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 size-9 shrink-0 md:hidden" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("subtitle")}
            </p>
          </div>
        </div>
        <Button size="sm" className="shrink-0" onClick={handleCreate}>
          <Plus className="h-4 w-4" />
          {t("new")}
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="animate-blur-rise flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border bg-card shadow-sm">
            <FolderKanban className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="mb-5 max-w-sm text-sm text-muted-foreground text-pretty">
            {t("empty")}
          </p>
          <Button size="sm" onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            {t("create")}
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
              {(project.defaultModel || project.systemPrompt) && (
                <CardContent>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {project.defaultModel && (
                      <span className="truncate max-w-[140px]">{displayModelName(project.defaultModel)}</span>
                    )}
                    {project.systemPrompt && (
                      <span>{t("customPrompt")}</span>
                    )}
                  </div>
                </CardContent>
              )}
              <CardFooter className="mt-auto justify-between">
                <span className="text-xs text-muted-foreground">
                  {formatDate(project.updatedAt)}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleEdit(project)}
                    aria-label={tc("edit")}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDeleteTarget(project)}
                    aria-label={tc("delete")}
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

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        title={t("confirmDeleteTitle", { name: deleteTarget?.name ?? "" })}
        description={t("confirmDeleteDesc")}
      />
    </div>
  );
}
