"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Plus, Pencil, Trash2, FolderKanban, MessageSquare, ChevronRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { SidebarTrigger } from "@/components/ui/sidebar";

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  // Three outcomes, not two. The list used to start as `[]`, so everyone saw
  // "you have no projects yet" for one round-trip — and a failed request left
  // that same sentence on screen permanently, telling people with eight
  // projects that they had none.
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const fetchProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((rows) => {
        setProjects(rows);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  function handleCreate() {
    setDialogOpen(true);
  }

  function formatDate(d: string) {
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

      {state === "loading" ? (
        // Rows in the shape of the real ones, inside the real container: the list
        // lands in place instead of replacing a centred spinner from a different
        // height.
        <div className="divide-y overflow-hidden rounded-xl border bg-card" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2 px-4 py-3.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      ) : state === "error" ? (
        <EmptyState icon={FolderKanban} title={t("loadError")} hint={t("loadErrorHint")} className="py-16">
          <Button variant="outline" size="sm" onClick={() => { setState("loading"); fetchProjects(); }}>
            <RotateCw className="h-4 w-4" />
            {tc("retry")}
          </Button>
        </EmptyState>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={t("empty")}
          hint={t("emptyHint")}
          className="animate-blur-rise py-16"
        >
          <Button size="sm" onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            {t("create")}
          </Button>
        </EmptyState>
      ) : (
        /* A list, not a two-column card grid. Projects differ by one line of text,
           so cards spent a lot of border and whitespace making eight of them look
           like eight unrelated things — and the row actions sat in a footer that
           was visible whether you wanted them or not. */
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {projects.map((project) => (
            <div key={project.id} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover">
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
                  {/* A bare em dash is developer shorthand; "no chats yet" is the
                      sentence the reader is actually owed. */}
                  <span className="truncate">
                    {project.lastChatAt ? t("lastChat", { date: formatDate(project.lastChatAt) }) : t("noChatsYet")}
                  </span>
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
