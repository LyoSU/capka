"use client";

import { useState, useEffect, useCallback } from "react";
import { FolderOpen, Plus, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";

interface ProjectSelectorProps {
  value: string | null;
  onChange: (projectId: string | null) => void;
}

export function ProjectSelector({ value, onChange }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const selectedName = value
    ? projects.find((p) => p.id === value)?.name ?? "Project"
    : "All Chats";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-sm" />
        }>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{selectedName}</span>
          <ChevronDown className="ml-auto h-3 w-3 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => onChange(null)}>
            All Chats
          </DropdownMenuItem>
          {projects.length > 0 && <DropdownMenuSeparator />}
          {projects.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => onChange(p.id)}>
              {p.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={(project) => {
          fetchProjects();
          onChange(project.id);
        }}
      />
    </>
  );
}
