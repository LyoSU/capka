"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import {
  Plus, Settings2, Trash2, FolderKanban, Cpu, Globe, FileText, MessageSquare, Loader2, RefreshCw, Check, ChevronLeft,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { SettingsSection, SettingsGroup, SettingsRow } from "@/components/settings/shell";
import { EmptyState } from "@/components/shared/empty-state";
import { PreviewProvider } from "@/components/chat/file-preview";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspaceBrowser, type FileEntry } from "@/components/chat/workspace-browser";
import { useFolderSync } from "@/components/chat/use-folder-sync";
import { type Project } from "@/components/projects/project-dialog";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { AgentModeSection } from "@/components/settings/agent-mode";
import { ASSISTANT_PROFILE, profilesEqual, type AgentProfile } from "@/lib/agents/profile";
import { projectTarget, targetQuery } from "@/lib/workspace-target";
import { displayModelName } from "@/lib/providers/registry";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

type ChatRow = { id: string; title: string | null; updatedAt: string | null };
export type HubTab = "overview" | "files" | "chats" | "settings";

const noop = async () => {};

/**
 * One chat row link — shared by the overview's recent list and the Chats tab.
 *
 * No border of its own: the rows live inside `ChatList`'s single card, hairline-
 * separated. Six individually bordered rows read as six unrelated objects, and it
 * was a third card style on a page that already had two.
 */
function ChatRowLink({ chat, locale, fallback }: { chat: ChatRow; locale: string; fallback: string }) {
  return (
    <Link href={`/chat/${chat.id}`} className="flex items-center gap-2 px-4 py-2.5 text-sm transition-colors hover:bg-hover">
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
  orgCeiling,
}: {
  project: Project;
  isAdmin?: boolean;
  initialTab?: HubTab;
  /** The instance-wide ceiling this project's profile is clamped by. Resolved
   *  server-side so the settings tab can show a capped switch as locked instead of
   *  letting it save a value the run would then ignore. */
  orgCeiling: AgentProfile;
}) {
  const t = useTranslations("projects.hub");
  const tp = useTranslations("projects");
  const router = useRouter();
  const locale = useLocale();
  const [project, setProject] = useState<Project>(initial);
  const [tab, setTabState] = useState<HubTab>(initialTab ?? "overview");

  /**
   * The URL is the authority on which tab is open; local state only mirrors it so a
   * click responds without waiting for a server round-trip.
   *
   * Reading `initialTab` once into `useState` was not enough. The sidebar's ⋮ →
   * Settings pushes `?tab=settings` for a project that is often the one already on
   * screen: the pathname doesn't change, so the hub is re-rendered with a new
   * `initialTab` but never remounted, and `useState` ignores an initial value on
   * re-render — the menu item did nothing whatsoever. Syncing from the prop is also
   * what makes the tab survive a reload and a shared link.
   */
  useEffect(() => {
    setTabState(initialTab ?? "overview");
  }, [initialTab]);

  const setTab = useCallback(
    (next: HubTab) => {
      setTabState(next);
      // `replace`, not `push`: switching tabs inside one page isn't a place in
      // history you want the Back button to walk through one by one. Overview is
      // the bare URL so the default carries no query string.
      router.replace(`/projects/${project.id}${next === "overview" ? "" : `?tab=${next}`}`, { scroll: false });
    },
    [router, project.id],
  );

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
        {/* Header. The way back to the project list lives here, not only in the
            sidebar: the sidebar's Projects section shows five, so on an instance
            with fewer there used to be no link to the full list at all, and from
            inside a project nothing said where you were. */}
        <div className="mb-4">
          <div className="flex items-center gap-1">
            <SidebarTrigger className="-ml-1 size-8 shrink-0 md:hidden" />
            <Link
              href="/projects"
              className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" />
              {tp("title")}
            </Link>
          </div>

          <div className="mt-1 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold">{project.name}</h1>
              {project.description && (
                <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{project.description}</p>
              )}
            </div>
            <Button size="sm" className="shrink-0" nativeButton={false} render={<Link href={newChatHref} />}>
              <Plus className="h-4 w-4" />
              {t("newChat")}
            </Button>
          </div>

          {/* How this project is set up, as one quiet line under its name — this
              was a bordered "Context" card on the overview, which gave three
              read-only facts the same visual weight as the workspace. It reads as
              identity here, and clicking it goes to the tab that changes it, so
              the header no longer needs a Settings button next to a Settings tab. */}
          {/* No aria-label here: it would REPLACE the three facts below as the
              accessible name, so a screen reader heard "Settings" and none of the
              instructions/model/internet state everyone else can read. The purpose
              is appended as a visually-hidden span instead. */}
          <button
            type="button"
            onClick={() => setTab("settings")}
            className="group mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5" />
              {project.systemPrompt ? t("hasInstructions") : t("noInstructions")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="size-3.5" />
              <span className="max-w-40 truncate">
                {project.defaultModel ? displayModelName(project.defaultModel) : t("defaultModel")}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Globe className="size-3.5" />
              {project.sandboxNetwork === "bridge" ? t("internetOn") : t("internetOff")}
            </span>
            <Settings2 className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100" />
            <span className="sr-only">{t("openSettings")}</span>
          </button>
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
              orgCeiling={orgCeiling}
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
    <div className="space-y-8 pb-6">
      {empty && (
        <EmptyState
          icon={FolderKanban}
          title={t("empty")}
          hint={t("emptyExplainer")}
          className="rounded-xl border border-dashed"
        >
          <Button size="sm" nativeButton={false} render={<Link href={`/chat?projectId=${project.id}`} />}>
            <Plus className="h-4 w-4" />
            {t("newChat")}
          </Button>
        </EmptyState>
      )}

      {!empty && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("recentChats")}</h2>
            <button onClick={onAllChats} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
              {t("allChats")}
            </button>
          </div>
          <ChatList>
            {recent.map((c) => (
              <ChatRowLink key={c.id} chat={c} locale={locale} fallback={t("untitledChat")} />
            ))}
          </ChatList>
        </section>
      )}

      {/* One row, not a card with a heading and two lines of nothing: on a fresh
          project the whole section used to be a big box reading "0 files". */}
      <SettingsGroup>
        <SettingsRow
          title={t("workspace")}
          hint={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{fileCount === null ? "…" : t("fileCount", { n: fileCount })}</span>
              {folderCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  {syncing
                    ? <RefreshCw className="h-3 w-3 animate-spin" />
                    : <Check className="h-3 w-3 text-success" />}
                  {t("folderCount", { n: folderCount })}
                </span>
              )}
            </span>
          }
          control={<Button variant="outline" size="sm" onClick={onOpenFiles}>{t("openFiles")}</Button>}
        />
      </SettingsGroup>

      {/* Memory gets its own heading. It was nested inside the "Context" card,
          under a label, which made the one editable thing on the overview look
          like a footnote to three read-only facts. */}
      <SettingsSection title={t("memoryLabel")} description={t("memoryHint")}>
        <MemoryEditor projectId={project.id} />
      </SettingsSection>
    </div>
  );
}

/** The Settings tab — the project's create-time basics plus the advanced knobs
 *  (instructions, model, internet). Lives on the hub page rather than in a modal
 *  so the model picker's dropdown has room to open (a dialog's centering
 *  transform + overflow clipping used to cut it off). */
function SettingsTab({
  project, isAdmin, orgCeiling, onSaved, onDelete,
}: {
  project: Project;
  isAdmin?: boolean;
  orgCeiling: AgentProfile;
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
  const savedProfile = project.agentProfile ?? ASSISTANT_PROFILE;
  const [profile, setProfile] = useState<AgentProfile>(savedProfile);

  const dirty =
    name !== project.name ||
    description !== (project.description ?? "") ||
    systemPrompt !== (project.systemPrompt ?? "") ||
    defaultModel !== (project.defaultModel ?? "") ||
    internetAccess !== (project.sandboxNetwork === "bridge") ||
    !profilesEqual(profile, savedProfile);

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
        // Trimmed here, because the server trims too (api/projects/[id]) and
        // `dirty` compares local state against the row it sends back. Posting
        // "text\n" stored "text", so the comparison stayed unequal and the
        // "unsaved changes" bar reappeared under its own success toast — saving
        // again changed nothing, and only Discard could clear it.
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          defaultModel: defaultModel.trim(),
          sandboxNetwork: internetAccess ? "bridge" : "none",
          agentProfile: profile,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t("updateError"));
        return;
      }
      const saved: Project = await res.json();
      toast.success(t("updated"));
      // Rename shows in the sidebar's Projects section — nudge it to refresh.
      window.dispatchEvent(new Event("projects:changed"));
      // Re-seed from the row the server actually stored, not from what was typed:
      // it has been trimmed and empty strings became null, so anything else leaves
      // `dirty` true against the value now on disk.
      seed(saved);
      onSaved(saved);
    } catch {
      toast.error(t("updateError"));
    } finally {
      setSaving(false);
    }
  }

  /** Point every field at one project row — used both to discard edits and to
   *  adopt the saved row after a successful write. */
  function seed(from: Project) {
    setName(from.name);
    setDescription(from.description ?? "");
    setSystemPrompt(from.systemPrompt ?? "");
    setDefaultModel(from.defaultModel ?? "");
    setInternetAccess(from.sandboxNetwork === "bridge");
    setProfile(from.agentProfile ?? ASSISTANT_PROFILE);
  }

  function reset() {
    seed(project);
  }

  return (
    <div className="max-w-2xl space-y-8 pb-4">
      <SettingsSection title={th("basics")}>
        <SettingsGroup>
          <SettingsRow title={t("form.name")} labelFor="project-name">
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("form.namePlaceholder")}
              // Mirrors lib/projects/schema.ts: over the bound, the API answers
              // with a raw English Zod sentence, which is not something to show
              // someone who pasted a long document by accident.
              maxLength={200}
            />
          </SettingsRow>
          <SettingsRow title={t("form.description")} labelFor="project-description">
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("form.descriptionPlaceholder")}
              maxLength={2000}
              className="max-h-40 min-h-16"
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      {/* Not monospaced any more. It's prose a colleague writes about how the
          assistant should behave, and a 12px mono box told them it was code. */}
      <SettingsSection title={t("form.systemPrompt")} footnote={t("form.systemPromptHint")}>
        <Textarea
          id="project-system-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t("form.systemPromptPlaceholder")}
          maxLength={20000}
          className="max-h-[50vh] min-h-32 text-sm leading-relaxed"
        />
      </SettingsSection>

      <SettingsSection title={th("howItWorks")}>
        <SettingsGroup>
          <SettingsRow title={t("form.defaultModel")} hint={t("form.defaultModelHint")}>
            <ModelPicker
              variant="field"
              value={defaultModel}
              onChange={setDefaultModel}
              placeholder={t("form.useGlobalDefault")}
              clearable
            />
          </SettingsRow>
          <SettingsRow
            title={t("form.internet")}
            hint={t("form.internetHint")}
            disabled={!profile.capabilities.sandbox}
            onLabelClick={() => setInternetAccess((v) => !v)}
            control={
              <Switch
                checked={internetAccess}
                onCheckedChange={setInternetAccess}
                disabled={!profile.capabilities.sandbox}
              />
            }
          />
        </SettingsGroup>

        <AgentModeSection
          profile={profile}
          onChange={setProfile}
          isAdmin={isAdmin}
          hasInstructions={!!systemPrompt.trim()}
          ceiling={orgCeiling}
        />
      </SettingsSection>

      {isAdmin && (
        <SettingsSection title={th("dangerTitle")} description={th("dangerHint")}>
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
            {th("delete")}
          </Button>
        </SettingsSection>
      )}

      {/* Sticky, because the form is taller than the pane: the Save button used to
          sit below the fold, so the way to keep an edit was to scroll for it. It
          appears only once there's something to save, and Discard is next to it —
          the honest pair, since leaving the tab does not warn. */}
      {dirty && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background/85 py-3 backdrop-blur">
          <span className="mr-auto text-xs text-muted-foreground">{th("unsaved")}</span>
          {/* "Discard", not "Cancel": next to Save, "Cancel" reads as cancelling
              the save rather than throwing the edits away. */}
          <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>{tc("discard")}</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? tc("saving") : tc("save")}
          </Button>
        </div>
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
    <div>
      {content === null ? (
        <Skeleton className="h-20" aria-hidden />
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
    return <EmptyState icon={MessageSquare} title={emptyLabel} />;
  }
  return (
    <ChatList>
      {chats.map((c) => (
        <ChatRowLink key={c.id} chat={c} locale={locale} fallback={t("untitledChat")} />
      ))}
    </ChatList>
  );
}

/** The card the chat rows sit in — same shape as SettingsGroup. */
function ChatList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>;
}
