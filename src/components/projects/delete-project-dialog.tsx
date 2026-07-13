"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Loader2, Trash2 } from "lucide-react";
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
import { projectTarget, targetQuery } from "@/lib/workspace-target";

type Counts = { chatCount: number; connectorCount: number; skillCount: number; automationCount: number };

/** Confirm-delete with the honest inventory of what the tombstone flow removes:
 *  project memory, connectors and skills are deleted; chats stay but lose the
 *  project; enabled automations are paused; workspace files are wiped. Offers a
 *  complete "download first" backup (the controller archive) before the wipe. */
export function DeleteProjectDialog({
  open,
  onOpenChange,
  project,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string };
  onDeleted: () => void;
}) {
  const t = useTranslations("projects.delete");
  const tc = useTranslations("common");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCounts(null);
    fetch(`/api/projects/${project.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setCounts({
        chatCount: d.chatCount ?? 0,
        connectorCount: d.connectorCount ?? 0,
        skillCount: d.skillCount ?? 0,
        automationCount: d.automationCount ?? 0,
      }))
      .catch(() => {});
  }, [open, project.id]);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const d = (await res.json().catch(() => ({}))) as { code?: string };
        toast.error(d.code === "SYNC_ACTIVE" ? t("blockedSync") : t("blockedTask"));
        return;
      }
      if (!res.ok) {
        toast.error(t("error"));
        return;
      }
      toast.success(t("deleted"));
      window.dispatchEvent(new Event("projects:changed")); // refresh the sidebar section
      onOpenChange(false);
      onDeleted();
    } catch {
      toast.error(t("error"));
    } finally {
      setDeleting(false);
    }
  }

  // Each inventory line renders only when its count is non-zero, so the dialog
  // states exactly what THIS project loses — nothing generic.
  const lines: string[] = [];
  if (counts) {
    lines.push(t("memory"));
    if (counts.connectorCount > 0) lines.push(t("connectors", { n: counts.connectorCount }));
    if (counts.skillCount > 0) lines.push(t("skills", { n: counts.skillCount }));
    if (counts.chatCount > 0) lines.push(t("chats", { n: counts.chatCount }));
    if (counts.automationCount > 0) lines.push(t("automations", { n: counts.automationCount }));
    lines.push(t("files"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { name: project.name })}</DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>

        {counts ? (
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {lines.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-muted-foreground/50">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" /></div>
        )}

        <a
          href={`/api/sandbox/files/archive?${targetQuery(projectTarget(project.id))}`}
          className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
        >
          <Download className="h-4 w-4" />
          {t("downloadFirst")}
        </a>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            {tc("cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
