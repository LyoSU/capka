"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Plus, Pencil, Trash2, FolderKanban, MessageSquare, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { SidebarTrigger } from "@/components/ui/sidebar";

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
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
    setDialogOpen(true);
  }

  function formatDate(d: string | null | undefined) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
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
        /* A list, not a two-column card grid. Projects differ by one line of text,
           so cards spent a lot of border and whitespace making eight of them look
           like eight unrelated things — and the row actions sat in a footer that
           was visible whether you wanted them or not. */
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {projects.map((project) => (
            <div key={project.id} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30">
              <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{project.name}</p>
                {project.description && (
                  <p className="truncate text-xs text-muted-foreground">{project.description}</p>
                )}
                {/* Full muted-foreground, not /80: at 12px the dimmed variant
                    measures ~4.0:1 on this card and misses WCAG AA. */}
                <p className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" />
                    {t("chatCount", { n: project.chatCount ?? 0 })}
                  </span>
                  <span className="truncate">{t("lastChat", { date: formatDate(project.lastChatAt) })}</span>
                </p>
              </Link>
              {/* Revealed on hover, always present for keyboard and touch. */}
              <div className="flex shrink-0 items-center gap-1 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  nativeButton={false}
                  render={<Link href={`/projects/${project.id}?tab=settings`} />}
                  aria-label={tc("edit")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={() => setDeleteTarget(project)} aria-label={tc("delete")}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
            </div>
          ))}
        </div>
      )}

      {/* Straight into the new project's settings, the same as creating one from
          the sidebar — the list behind it is refreshed on the way out. */}
      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={(project) => {
          fetchProjects();
          router.push(`/projects/${project.id}?tab=settings`);
        }}
      />

      {deleteTarget && (
        <DeleteProjectDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          project={{ id: deleteTarget.id, name: deleteTarget.name }}
          onDeleted={() => { setDeleteTarget(null); fetchProjects(); }}
        />
      )}
    </div>
  );
}
