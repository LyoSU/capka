"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { FolderKanban, Plus, FolderOpen } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";

// The sidebar's "Projects" section: a flat list of the few most-recently-active
// projects (the API already sorts by coalesce(lastChatAt, createdAt) desc, so a
// brand-new empty project still shows). Clicking one opens its hub; the chat list
// below is NEVER filtered by it — the route + DB are the single source of truth
// for which workspace a chat uses, so there is no client "selected project" state.
const MAX_SHOWN = 5;

export function ProjectsNav() {
  const t = useTranslations("projects");
  const pathname = usePathname();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then(setProjects)
      .catch(() => {});
  }, []);

  // Fetch once on mount; refresh on an explicit "projects:changed" event (dispatched
  // by create/edit/delete) rather than on every navigation — a route change doesn't
  // alter the project list, so re-fetching on `pathname` was pure waste.
  useEffect(() => {
    fetchProjects();
    window.addEventListener("projects:changed", fetchProjects);
    return () => window.removeEventListener("projects:changed", fetchProjects);
  }, [fetchProjects]);

  const activeId = pathname.startsWith("/projects/") ? pathname.split("/")[2] : null;
  const shown = projects.slice(0, MAX_SHOWN);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t("title")}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {shown.map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton render={<Link href={`/projects/${p.id}`} />} data-active={activeId === p.id || undefined}>
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setDialogOpen(true)} className="text-muted-foreground">
              <Plus className="h-4 w-4" strokeWidth={2.5} />
              <span>{t("new")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {projects.length > MAX_SHOWN && (
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link href="/projects" />} className="text-muted-foreground">
                <FolderKanban className="h-4 w-4" />
                <span>{t("selector.manage")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>

      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={(p) => { fetchProjects(); router.push(`/projects/${p.id}`); }}
      />
    </SidebarGroup>
  );
}
