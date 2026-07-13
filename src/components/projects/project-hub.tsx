"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import {
  Plus, Settings, Trash2, FolderKanban, FolderOpen, Cpu, Globe, FileText, MessageSquare, Loader2, RefreshCw, Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PreviewProvider } from "@/components/chat/file-preview";
import { WorkspaceBrowser, type FileEntry } from "@/components/chat/workspace-browser";
import { useFolderSync } from "@/components/chat/use-folder-sync";
import { ProjectDialog, type Project } from "@/components/projects/project-dialog";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { projectTarget, targetQuery } from "@/lib/workspace-target";
import { displayModelName } from "@/lib/providers/registry";
import { cn } from "@/lib/utils";

type ChatRow = { id: string; title: string | null; updatedAt: string | null };
type Tab = "overview" | "files" | "chats";

const noop = async () => {};

/** One chat row link — shared by the overview's recent list and the Chats tab. */
function ChatRowLink({ chat, locale, fallback }: { chat: ChatRow; locale: string; fallback: string }) {
  return (
    <Link href={`/chat/${chat.id}`} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm transition-colors hover:bg-accent/40">
      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{chat.title || fallback}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric" }) : ""}
      </span>
    </Link>
  );
}

export function ProjectHub({ project: initial, isAdmin }: { project: Project; isAdmin?: boolean }) {
  const t = useTranslations("projects.hub");
  const router = useRouter();
  const locale = useLocale();
  const [project, setProject] = useState<Project>(initial);
  const [tab, setTab] = useState<Tab>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [chats, setChats] = useState<ChatRow[] | null>(null);
  // Root workspace entries — fetched ONCE here (for the overview file count) and
  // handed to WorkspaceBrowser as its seed so the Files tab doesn't re-fetch the
  // same listing; WorkspaceBrowser reports back via onLoaded to keep the count fresh.
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const fileCount = entries === null ? null : entries.filter((e) => !e.name.startsWith(".")).length;

  const target = useMemo(() => projectTarget(project.id), [project.id]);
  // Project folders always exist server-side, so ensureChat is a no-op here.
  const folderSync = useFolderSync({ target, ensureChat: noop });

  const loadChats = useCallback(() => {
    fetch(`/api/chats?projectId=${encodeURIComponent(project.id)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ChatRow[]) => setChats(rows))
      .catch(() => setChats([]));
  }, [project.id]);

  useEffect(() => {
    loadChats();
    fetch(`/api/sandbox/files?${targetQuery(target)}`)
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((d: { entries?: FileEntry[] }) => setEntries(d.entries ?? []))
      .catch(() => setEntries([]));
  }, [target, loadChats]);

  const onEntriesLoaded = useCallback((e: FileEntry[]) => setEntries(e), []);

  const newChatHref = `/chat?projectId=${project.id}`;

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: t("tabs.overview") },
    { key: "files", label: t("tabs.files") },
    { key: "chats", label: t("tabs.chats") },
  ];

  return (
    <PreviewProvider>
      {/* w-full is load-bearing: the dashboard main is a flex column, and mx-auto
          disables its cross-axis stretch — without an explicit width the hub
          collapses to the header's max-content (~420px). */}
      <div className="animate-fade-in mx-auto flex h-full w-full max-w-4xl flex-col px-4 py-6">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <SidebarTrigger className="-ml-1 size-9 shrink-0 md:hidden" />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold">{project.name}</h1>
              {project.description && (
                <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{project.description}</p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" render={<Link href={newChatHref} />}>
              <Plus className="h-4 w-4" />
              {t("newChat")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Settings className="h-4 w-4" />
              {t("settings")}
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label={t("tabsLabel")} className="mb-4 flex gap-1 border-b">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              role="tab"
              aria-selected={tab === tb.key}
              onClick={() => setTab(tb.key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === tb.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1">
          {tab === "overview" && (
            <OverviewTab
              project={project}
              chats={chats}
              fileCount={fileCount}
              folderCount={folderSync.folders.length}
              syncing={folderSync.phase === "syncing"}
              locale={locale}
              onOpenFiles={() => setTab("files")}
              onAllChats={() => setTab("chats")}
              onDelete={() => setDeleteOpen(true)}
              isAdmin={isAdmin}
            />
          )}

          {tab === "files" && (
            <div className="h-[calc(100dvh-14rem)] overflow-hidden rounded-xl border">
              <WorkspaceBrowser
                target={target}
                folderSync={folderSync}
                initialEntries={entries ?? undefined}
                onLoaded={onEntriesLoaded}
              />
            </div>
          )}

          {tab === "chats" && <ChatsList chats={chats} locale={locale} emptyLabel={t("noChats")} />}
        </div>
      </div>

      <ProjectDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        project={project}
        onSaved={(p) => setProject(p)}
      />
      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        project={{ id: project.id, name: project.name }}
        onDeleted={() => router.push("/projects")}
      />
    </PreviewProvider>
  );
}

function OverviewTab({
  project, chats, fileCount, folderCount, syncing, locale, onOpenFiles, onAllChats, onDelete, isAdmin,
}: {
  project: Project;
  chats: ChatRow[] | null;
  fileCount: number | null;
  folderCount: number;
  syncing: boolean;
  locale: string;
  onOpenFiles: () => void;
  onAllChats: () => void;
  onDelete: () => void;
  isAdmin?: boolean;
}) {
  const t = useTranslations("projects.hub");
  const recent = (chats ?? []).slice(0, 6);
  const empty = chats !== null && chats.length === 0;

  return (
    <div className="space-y-5">
      {empty && (
        <div className="rounded-xl border bg-muted/20 px-4 py-6 text-center">
          <FolderKanban className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">{t("emptyExplainer")}</p>
          <Button size="sm" className="mt-4" render={<Link href={`/chat?projectId=${project.id}`} />}>
            <Plus className="h-4 w-4" />
            {t("newChat")}
          </Button>
        </div>
      )}

      {/* Recent chats */}
      {!empty && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("recentChats")}</h2>
            <button onClick={onAllChats} className="text-xs text-muted-foreground hover:text-foreground">{t("allChats")}</button>
          </div>
          <div className="grid gap-1.5">
            {recent.map((c) => (
              <ChatRowLink key={c.id} chat={c} locale={locale} fallback={t("untitledChat")} />
            ))}
          </div>
        </section>
      )}

      {/* Workspace */}
      <section className="rounded-xl border p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            {t("workspace")}
          </h2>
          <Button variant="outline" size="sm" onClick={onOpenFiles}>{t("openFiles")}</Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{fileCount === null ? "…" : t("fileCount", { n: fileCount })}</span>
          {folderCount > 0 && (
            <span className="inline-flex items-center gap-1">
              {syncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" />}
              {t("folderCount", { n: folderCount })}
            </span>
          )}
        </div>
      </section>

      {/* Context */}
      <section className="rounded-xl border p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("context")}</h2>
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            {project.systemPrompt ? t("hasInstructions") : t("noInstructions")}
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" />
            <span className="truncate">{project.defaultModel ? displayModelName(project.defaultModel) : t("defaultModel")}</span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            {project.sandboxNetwork === "bridge" ? t("internetOn") : t("internetOff")}
          </div>
        </div>
        <MemoryEditor projectId={project.id} />
      </section>

      {isAdmin && (
        <section className="rounded-xl border border-destructive/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t("dangerTitle")}</h2>
              <p className="text-xs text-muted-foreground">{t("dangerHint")}</p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 text-destructive hover:text-destructive" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
              {t("delete")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/** The project's memory doc — "what the assistant remembered" — inline, using the
 *  same /api/memory-docs mechanics as settings but scoped to this project. */
function MemoryEditor({ projectId }: { projectId: string }) {
  const t = useTranslations("projects.hub");
  const tc = useTranslations("common");
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/memory-docs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { projects?: { id: string; content: string }[] } | null) => {
        const c = d?.projects?.find((p) => p.id === projectId)?.content ?? "";
        setContent(c);
        setDraft(c);
      })
      .catch(() => { setContent(""); setDraft(""); });
  }, [projectId]);

  const dirty = content !== null && draft !== content;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/memory-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, projectId }),
      });
      if (!res.ok) throw new Error();
      setContent(draft);
      toast.success(t("memorySaved"));
    } catch {
      toast.error(t("memoryError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4">
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t("memoryLabel")}</label>
      {content === null ? (
        <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" /></div>
      ) : (
        <>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("memoryPlaceholder")}
            className="max-h-64 min-h-20 text-sm"
          />
          {dirty && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? tc("saving") : tc("save")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ChatsList({ chats, locale, emptyLabel }: { chats: ChatRow[] | null; locale: string; emptyLabel: string }) {
  const t = useTranslations("projects.hub");
  if (chats === null) {
    return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" /></div>;
  }
  if (chats.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="grid gap-1.5">
      {chats.map((c) => (
        <ChatRowLink key={c.id} chat={c} locale={locale} fallback={t("untitledChat")} />
      ))}
    </div>
  );
}
