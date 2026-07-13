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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PreviewProvider } from "@/components/chat/file-preview";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspaceBrowser, type FileEntry } from "@/components/chat/workspace-browser";
import { useFolderSync } from "@/components/chat/use-folder-sync";
import { type Project } from "@/components/projects/project-dialog";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { projectTarget, targetQuery } from "@/lib/workspace-target";
import { displayModelName } from "@/lib/providers/registry";
import { cn } from "@/lib/utils";

type ChatRow = { id: string; title: string | null; updatedAt: string | null };
export type HubTab = "overview" | "files" | "chats" | "settings";

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

export function ProjectHub({
  project: initial,
  isAdmin,
  initialTab,
}: {
  project: Project;
  isAdmin?: boolean;
  initialTab?: HubTab;
}) {
  const t = useTranslations("projects.hub");
  const router = useRouter();
  const locale = useLocale();
  const [project, setProject] = useState<Project>(initial);
  const [tab, setTab] = useState<HubTab>(initialTab ?? "overview");
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

  const tabs: { key: HubTab; label: string }[] = [
    { key: "overview", label: t("tabs.overview") },
    { key: "files", label: t("tabs.files") },
    { key: "chats", label: t("tabs.chats") },
    { key: "settings", label: t("settings") },
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
            <Button variant="outline" size="sm" onClick={() => setTab("settings")}>
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

        {/* The tab pane is the scroll container (the dashboard main is
            overflow-hidden), so long content scrolls under the pinned header +
            tabs instead of being clipped. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
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

          {tab === "settings" && (
            <SettingsTab
              project={project}
              isAdmin={isAdmin}
              onSaved={setProject}
              onDelete={() => setDeleteOpen(true)}
            />
          )}
        </div>
      </div>

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
  project, chats, fileCount, folderCount, syncing, locale, onOpenFiles, onAllChats,
}: {
  project: Project;
  chats: ChatRow[] | null;
  fileCount: number | null;
  folderCount: number;
  syncing: boolean;
  locale: string;
  onOpenFiles: () => void;
  onAllChats: () => void;
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
    </div>
  );
}

/** The Settings tab — the project's create-time basics plus the advanced knobs
 *  (instructions, model, internet). Lives on the hub page rather than in a modal
 *  so the model picker's dropdown has room to open (a dialog's centering
 *  transform + overflow clipping used to cut it off). */
function SettingsTab({
  project, isAdmin, onSaved, onDelete,
}: {
  project: Project;
  isAdmin?: boolean;
  onSaved: (p: Project) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("projects");
  const th = useTranslations("projects.hub");
  const tc = useTranslations("common");
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt ?? "");
  const [defaultModel, setDefaultModel] = useState(project.defaultModel ?? "");
  const [internetAccess, setInternetAccess] = useState(project.sandboxNetwork === "bridge");

  const dirty =
    name !== project.name ||
    description !== (project.description ?? "") ||
    systemPrompt !== (project.systemPrompt ?? "") ||
    defaultModel !== (project.defaultModel ?? "") ||
    internetAccess !== (project.sandboxNetwork === "bridge");

  async function save() {
    if (!name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, systemPrompt, defaultModel, sandboxNetwork: internetAccess ? "bridge" : "none" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t("updateError"));
        return;
      }
      const saved = await res.json();
      toast.success(t("updated"));
      // Rename shows in the sidebar's Projects section — nudge it to refresh.
      window.dispatchEvent(new Event("projects:changed"));
      onSaved(saved);
    } catch {
      toast.error(t("updateError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4 pb-6">
      <div className="space-y-1.5">
        <Label htmlFor="project-name">{t("form.name")}</Label>
        <Input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("form.namePlaceholder")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-description">{t("form.description")}</Label>
        <Textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("form.descriptionPlaceholder")}
          className="max-h-40 min-h-16"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-system-prompt">{t("form.systemPrompt")}</Label>
        <Textarea
          id="project-system-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t("form.systemPromptPlaceholder")}
          className="max-h-[50vh] min-h-28 font-mono text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project-default-model">{t("form.defaultModel")}</Label>
        <ModelPicker
          variant="field"
          value={defaultModel}
          onChange={setDefaultModel}
          placeholder={t("form.useGlobalDefault")}
          clearable
        />
        <p className="text-xs text-muted-foreground">{t("form.defaultModelHint")}</p>
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="sandbox-internet">{t("form.internet")}</Label>
          <p className="text-xs text-muted-foreground">{t("form.internetHint")}</p>
        </div>
        <Switch
          id="sandbox-internet"
          checked={internetAccess}
          onCheckedChange={setInternetAccess}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? tc("saving") : tc("save")}
        </Button>
      </div>

      {isAdmin && (
        <section className="rounded-xl border border-destructive/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{th("dangerTitle")}</h2>
              <p className="text-xs text-muted-foreground">{th("dangerHint")}</p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 text-destructive hover:text-destructive" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
              {th("delete")}
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
