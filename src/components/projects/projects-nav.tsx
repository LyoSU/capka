"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { FolderKanban, Plus, FolderOpen, MoreVertical, Settings2, MessageSquarePlus } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { ActionMenu } from "@/components/ui/action-menu";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLongPress } from "@/hooks/use-long-press";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";

// The sidebar's "Projects" section: a flat list of the few most-recently-active
// projects (the API already sorts by coalesce(lastChatAt, createdAt) desc, so a
// brand-new empty project still shows). Clicking one opens its hub; the chat list
// below is NEVER filtered by it — the route + DB are the single source of truth
// for which workspace a chat uses, so there is no client "selected project" state.
const MAX_SHOWN = 5;

/**
 * One project row, with the same affordances a chat row has: ⋮ on hover, long-press
 * on touch, both opening the same action list.
 *
 * They were plain links before, which made the section read as decoration — a list
 * you could look at and enter, but not act on, while every neighbouring row in the
 * sidebar had a menu. Settings deep-links straight to the hub's Settings tab rather
 * than its overview, so "rename this" is one click instead of three.
 *
 * Deletion is deliberately NOT here. The hub's Settings tab already confirms it with
 * the actual consequences spelled out (which memory is wiped, which connectors get
 * detached); a shorter confirmation in the sidebar would be the easier of two paths
 * to the same irreversible act.
 */
function ProjectRow({ project, active }: { project: Project; active: boolean }) {
  const t = useTranslations("projects.hub");
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  // Long-press opens the menu on touch; the click the finger-lift fires on the
  // underlying Link is swallowed so the row doesn't navigate at the same time.
  const firedRef = useRef(false);
  const longPress = useLongPress(() => {
    firedRef.current = true;
    setMenuOpen(true);
    haptic("tap");
  });

  return (
    <SidebarMenuItem
      className="pointer-coarse:select-none [-webkit-touch-callout:none]"
      {...longPress}
      onTouchStart={(e) => { firedRef.current = false; longPress.onTouchStart(e); }}
      onClickCapture={(e) => {
        if (firedRef.current) {
          e.preventDefault();
          e.stopPropagation();
          firedRef.current = false;
        }
      }}
    >
      <ActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={project.name}
        ariaLabel={t("settings")}
        contentProps={{ align: "start", className: "w-48" }}
        items={[
          {
            key: "new-chat",
            icon: <MessageSquarePlus className="size-4" />,
            label: t("newChat"),
            onSelect: () => router.push(`/chat?projectId=${project.id}`),
          },
          {
            key: "settings",
            icon: <Settings2 className="size-4" />,
            label: t("settings"),
            onSelect: () => router.push(`/projects/${project.id}?tab=settings`),
          },
        ]}
      >
        {/* Invisible zero-size anchor. The popup positions against a trigger inside
            the menu root, and the visible ⋮ below is a plain button (so it can sit
            beside the anchor and drive the controlled `open`) — leaving this out is
            what made the ⋮ silently do nothing. pointer-events-none so no tap can
            land on it. */}
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          nativeButton={false}
          render={<span />}
          className="pointer-events-none absolute right-1 top-1/2 z-10 h-0 w-0 -translate-y-1/2"
        />
        <SidebarMenuButton render={<Link href={`/projects/${project.id}`} />} data-active={active || undefined}>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{project.name}</span>
        </SidebarMenuButton>
        <button
          type="button"
          data-sidebar="menu-action"
          aria-label={t("settings")}
          onClick={() => setMenuOpen(true)}
          className={cn(
            "absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors before:absolute before:-inset-2.5 before:content-[''] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 pointer-coarse:hidden sm:opacity-0 sm:group-hover/menu-item:opacity-100",
            menuOpen && "bg-sidebar-accent text-sidebar-accent-foreground opacity-100",
          )}
        >
          <MoreVertical className="size-4" />
        </button>
      </ActionMenu>
    </SidebarMenuItem>
  );
}

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
            <ProjectRow key={p.id} project={p} active={activeId === p.id} />
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
        onSaved={(p) => {
          fetchProjects();
          // Straight to Settings, not the empty overview: someone who just named a
          // project is still describing it, and everything else about it lives
          // there. The overview has nothing to show yet anyway.
          router.push(`/projects/${p.id}?tab=settings`);
        }}
      />
    </SidebarGroup>
  );
}
