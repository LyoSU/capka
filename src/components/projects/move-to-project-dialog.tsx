"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, FolderOpen, Loader2, MinusCircle } from "lucide-react";
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
import { cn } from "@/lib/utils";

type ProjectLite = { id: string; name: string };

/** Which sentence the move earned. A move succeeds even when a folder cannot come
 *  along — the destination already has one under that name, and a rejected move
 *  would be worse than a folder left behind — and the server names the ones that
 *  stayed in `foldersNotCarried`. Reporting a plain "moved" for that case leaves the
 *  person hunting for a folder that quietly stopped being attached to this chat.
 *  Pure, and separate from the component so it can be tested. */
export function moveOutcome(body: unknown): { key: "moved" | "foldersLeftBehind"; folders: string[] } {
  const listed = (body as { foldersNotCarried?: unknown } | null)?.foldersNotCarried;
  const folders = Array.isArray(listed) ? listed.filter((n): n is string => typeof n === "string" && n !== "") : [];
  return folders.length > 0 ? { key: "foldersLeftBehind", folders } : { key: "moved", folders: [] };
}

/** Move a chat between projects (or out of one). Presents the honest matrix
 *  message for the chosen destination before applying — a project-less chat's
 *  files are copied in; a chat already in a project keeps that project's shared
 *  files where they are; "remove" starts a fresh empty workspace. Blocks with a
 *  plain message if the chat is still working (server precondition). */
export function MoveToProjectDialog({
  open,
  onOpenChange,
  chat,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: { id: string; title: string | null; projectId: string | null };
  onMoved: () => void;
}) {
  const t = useTranslations("projects.move");
  const tc = useTranslations("common");
  const [projects, setProjects] = useState<ProjectLite[] | null>(null);
  // `undefined` = nothing chosen yet; `null` = remove from project; string = a target.
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChoice(undefined);
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ProjectLite[]) => setProjects(rows))
      .catch(() => setProjects([]));
  }, [open]);

  const currentName = projects?.find((p) => p.id === chat.projectId)?.name;
  const targetName = typeof choice === "string" ? projects?.find((p) => p.id === choice)?.name : undefined;

  // The message for the chosen destination — the "matrix" from the spec.
  const message = (() => {
    if (choice === undefined) return null;
    if (choice === null) return t("toNone");
    if (!chat.projectId) return t("fromNone", { name: targetName ?? "" });
    return t("betweenProjects", { to: targetName ?? "", from: currentName ?? "" });
  })();

  async function move() {
    if (choice === undefined) return;
    setMoving(true);
    try {
      const res = await fetch(`/api/chats/${chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: choice }),
      });
      if (res.status === 409) {
        const d = (await res.json().catch(() => ({}))) as { code?: string };
        toast.error(d.code === "TASK_RUNNING" ? t("blockedTask") : t("error"));
        return;
      }
      if (!res.ok) { toast.error(t("error")); return; }
      const outcome = moveOutcome(await res.json().catch(() => null));
      if (outcome.key === "foldersLeftBehind") {
        toast.warning(t("foldersLeftBehind", { folders: outcome.folders.join(", "), count: outcome.folders.length }));
      } else {
        toast.success(t("moved"));
      }
      onOpenChange(false);
      onMoved();
    } catch {
      toast.error(t("error"));
    } finally {
      setMoving(false);
    }
  }

  const options = (projects ?? []).filter((p) => p.id !== chat.projectId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-4">
          {chat.projectId && (
            <button
              type="button"
              onClick={() => setChoice(null)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                choice === null ? "border-primary bg-hover-strong" : "border-border hover:bg-hover",
              )}
            >
              <MinusCircle className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{t("removeFromProject")}</span>
              {choice === null && <Check className="size-4 shrink-0 text-primary" />}
            </button>
          )}
          {projects === null ? (
            <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground/40" /></div>
          ) : options.length === 0 && !chat.projectId ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("noProjects")}</p>
          ) : (
            options.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setChoice(p.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                  choice === p.id ? "border-primary bg-hover-strong" : "border-border hover:bg-hover",
                )}
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {choice === p.id && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            ))
          )}
        </div>

        {message && <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground text-pretty">{message}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={moving}>{tc("cancel")}</Button>
          <Button onClick={move} disabled={moving || choice === undefined}>
            {moving ? <Loader2 className="animate-spin" /> : null}
            {t("moveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
