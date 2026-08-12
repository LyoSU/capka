"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import {
  Plus, Trash2, FolderKanban, Cpu, Globe, FileText, MessageSquare, Loader2, RefreshCw, Check, ChevronLeft,
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

/** One panel swapped between four tabs, so one id — every tab's `aria-controls`
 *  points here and the panel names itself after whichever tab is selected. */
const HUB_PANEL_ID = "hub-tabpanel";

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
  defaultModelName,
}: {
  project: Project;
  isAdmin?: boolean;
  initialTab?: HubTab;
  /** The default model's readable name from the synced catalog, resolved
   *  server-side. Null for a custom model no catalog lists — the header then
   *  shows the id as typed, which is all anyone can honestly say about it. */
  defaultModelName?: string | null;
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
  const tablistRef = useRef<HTMLDivElement>(null);

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
      {/* ONE scroll region, and it spans the full pane rather than sitting inside
          the centred column.
          It used to be the other way round: the header and tabs were pinned and
          only the tab's content scrolled, inside `mx-auto max-w-4xl`. That put the
          scrollbar on the right edge of an 864px column — floating in open space
          ~350px from the content it scrolled, reading as an artefact rather than a
          control — and it sliced text along an invisible line under the tabs,
          because a scrollport edge cuts mid-glyph with nothing to say it meant to.
          The whole page scrolling is also what every other dashboard page does
          (see settings/layout.tsx), so the scrollbar lands at the window edge
          where people already look for it.
          scrollbar-gutter:stable reserves that lane, so content doesn't shift
          sideways the moment a tab becomes tall enough to scroll. */}
      <div className="animate-fade-in h-full overflow-y-auto [scrollbar-gutter:stable]">
        {/* max-w-3xl, one measure for every tab. Overview used to be 896px wide and
            Settings 672px, so switching tabs visibly changed the page's width —
            and a 900px card holding one short chat title is what made the overview
            read as empty. 768px is wide enough for the file browser and still a
            comfortable measure for a column of form rows. */}
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {/* Header. The way back to the project list lives here, not only in the
            sidebar: the sidebar's Projects section shows five, so on an instance
            with fewer there used to be no link to the full list at all, and from
            inside a project nothing said where you were. */}
        {/* mb-6: the header used to end 16px above the tab rail, so the project's
            identity and the page's navigation ran together as one dense block. */}
        <div className="mb-6">
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

          <div className="mt-1.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              {/* text-2xl, not text-xl: at 20px the project's name measured the same
                  as the section headings below it, so the page had no subject — just
                  five things at one level. A settings page can sit at 20px because
                  its title is a category; this one names the object everything else
                  on the page is about. */}
              <h1 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
              {project.description && (
                <p className="mt-1 text-sm text-muted-foreground text-pretty">{project.description}</p>
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
              identity here.
              Text, not a button. It used to be one big clickable line jumping to
              Settings, with a gear that faded in on hover — so the only hint that
              a line of status was a control appeared once you had already pointed
              at it, and a click meant to select the model's name navigated away
              instead. "Click the status to change it" also isn't a metaphor office
              staff bring with them. The Settings tab is labelled and sits 40px
              below, so the shortcut cost more confusion than it saved clicks. */}
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5" />
              {project.systemPrompt ? t("hasInstructions") : t("noInstructions")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="size-3.5" />
              <span className="max-w-40 truncate">
                {project.defaultModel
                  ? defaultModelName ?? displayModelName(project.defaultModel)
                  : t("defaultModel")}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Globe className="size-3.5" />
              {project.sandboxNetwork === "bridge" ? t("internetOn") : t("internetOff")}
            </span>
          </p>
        </div>

        {/* Tabs. A `role="tablist"` announces a widget with rules attached, and
            this one kept none of them: no tab pointed at its panel, every tab was
            its own stop in the tab order, and the arrow keys did nothing. A screen
            reader heard "tab, 1 of 4" and had no panel to follow, while a keyboard
            user paid four Tab presses to walk past a control they weren't using —
            worse than plain buttons would have been. */}
        <div
          ref={tablistRef}
          role="tablist"
          aria-label={t("tabsLabel")}
          className="mb-4 flex gap-1 border-b"
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.key === tab);
            const next =
              e.key === "ArrowRight" ? (i + 1) % tabs.length
              : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
              : e.key === "Home" ? 0
              : e.key === "End" ? tabs.length - 1
              : -1;
            if (next < 0) return;
            // Arrows own horizontal movement inside a tablist, so stop the page
            // from also scrolling sideways under it.
            e.preventDefault();
            setTab(tabs[next].key);
            // Focus has to travel with the selection, or the next arrow press is
            // read from a tab that is no longer the current one.
            tablistRef.current?.querySelector<HTMLButtonElement>(`#hub-tab-${tabs[next].key}`)?.focus();
          }}
        >
          {tabs.map((tb) => (
            <button
              key={tb.key}
              id={`hub-tab-${tb.key}`}
              role="tab"
              aria-selected={tab === tb.key}
              aria-controls={HUB_PANEL_ID}
              // Roving tabindex: the whole strip is ONE stop in the tab order and
              // the arrows move within it — that's the contract role="tab" implies.
              tabIndex={tab === tb.key ? 0 : -1}
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

        {/* Plain content, no overflow of its own — the page above is the one and
            only scroller. This box used to be `overflow-y-auto`, which also turned
            the computed `overflow-x` into `auto` (per the CSS overflow spec,
            `visible` on one axis can't survive a non-visible other axis) and so
            clipped sideways at exactly the card edges — and `--elev-panel` draws a
            card's visible border as an OUTSET 1px ring, so every card lost its left
            and right border. With no clipping box here, there is nothing to bleed
            out of. */}
        <div id={HUB_PANEL_ID} role="tabpanel" aria-labelledby={`hub-tab-${tab}`}>
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
            /* The file browser scrolls internally, so it needs a height of its own.
               It was `calc(100dvh - 14rem)`, where 14rem stood for "header + tabs" —
               but the dashboard stacks up to three banners (provider status, update,
               org change) above all this, and each one pushed the browser that much
               further past the bottom of the window, cut off exactly when there was
               something to tell the user. A plain fraction of the viewport subtracts
               no chrome it has to keep guessing at, and the page scrolls to reveal
               the rest. min-h keeps it usable on a short laptop window. */
            <div className="h-[60vh] min-h-80 overflow-hidden rounded-xl bg-card shadow-hairline">
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
              // refresh() re-runs the server component so the header picks up the
              // new model's catalog name. Without it, saving a different model left
              // the old name in the identity line until a full reload — the local
              // row updates, but the resolved name is a server prop.
              onSaved={(p) => { setProject(p); router.refresh(); }}
              onDelete={() => setDeleteOpen(true)}
            />
          )}
        </div>
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

      {/* Same shape as the chats block above: a heading with one quiet action on
          the right, then a card. This was the only block on the overview with no
          heading at all — a card floating between two titled sections, which is
          what made the page read as assembled rather than laid out. Its "Open
          files" was also the page's only outline Button, competing with the one
          primary action in the header; as a text action beside the heading it
          matches "All chats" and the row it opens. */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("workspace")}</h2>
          <button onClick={onOpenFiles} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            {t("openFiles")}
          </button>
        </div>
        {/* Deliberately the same row geometry as ChatRowLink — icon, text, meta
            right — so the overview is two instances of one card, not two designs. */}
        <div className="flex items-center gap-2 rounded-xl bg-card px-4 py-2.5 text-sm shadow-hairline">
          <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">{fileCount === null ? "…" : t("fileCount", { n: fileCount })}</span>
          {folderCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {syncing
                ? <RefreshCw className="h-3 w-3 animate-spin" />
                : <Check className="h-3 w-3 text-success" />}
              {t("folderCount", { n: folderCount })}
            </span>
          )}
        </div>
      </section>

      {/* Memory gets its own heading. It was nested inside the "Context" card,
          under a label, which made the one editable thing on the overview look
          like a footnote to three read-only facts.
          Hidden until the project has been used at all: "what the assistant
          remembered" is an odd thing to hand someone as a blank box on a project
          that has never run once, and it competed with the one action a fresh
          project actually wants — start the first chat. Files stay available above
          it, because dropping documents in before the first chat is a real way to
          begin. */}
      {/* An h2 like its two neighbours, not SettingsSection's h3: as an h3 the
          markup said memory was a SUBSECTION of the recent chats above it, which
          is what a screen reader read out. */}
      {!empty && (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">{t("memoryLabel")}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{t("memoryHint")}</p>
          </div>
          <MemoryEditor projectId={project.id} />
        </section>
      )}
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
    /* No max-width of its own: the hub gives every tab one column, so Settings
       no longer narrows the page to 672px while Overview stayed at 896px. */
    <div className="space-y-8 pb-4">
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

      {/* Not admin-gated. `DELETE /api/projects/[id]` is `requireRole("admin",
          "user")` scoped to the owner, and /projects already gives every owner a
          trash button on the row — so gating it here only meant a regular user
          could delete their project from the list but not from the project's own
          settings, which is the first place anyone looks. The confirmation dialog,
          not a hidden button, is what protects this. */}
      <SettingsSection title={th("dangerTitle")} description={th("dangerHint")}>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
          {th("delete")}
        </Button>
      </SettingsSection>

      {/* Sticky, because the form is taller than the pane: the Save button used to
          sit below the fold, so the way to keep an edit was to scroll for it. It
          appears only once there's something to save, and Discard is next to it —
          the honest pair, since leaving the tab does not warn. */}
      {dirty && (
        /* It slides in rather than appearing: this bar arrives on the first
           keystroke, and a bar that materialises under your hands reads as the
           page glitching. 150ms is under the reduced-motion global kill switch in
           globals.css, so it simply appears for anyone who asked for that. */
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background/85 py-3 backdrop-blur animate-in fade-in-0 slide-in-from-bottom-2 duration-150">
          {/* role="status" on the sentence, NOT the bar: a live region containing
              Save and Discard would re-announce the buttons on every change. */}
          <span role="status" className="mr-auto text-xs text-muted-foreground">{th("unsaved")}</span>
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

/** The card the chat rows sit in.
 *
 *  shadow-hairline, not shadow-panel: a card that groups rows sits IN the page, it
 *  doesn't float above it, and `--elev-panel` adds two soft drop-shadow layers on
 *  top of the ring for a lift this container hasn't earned — three of them stacked
 *  down the overview read as a card grid. The ring is what was doing the work
 *  anyway: `--card` measures 1.07:1 against the page, so the boundary is the
 *  hairline, not the shadow. Depth stays reserved for things that genuinely cover
 *  other content (`--elev-overlay`). */
function ChatList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl bg-card shadow-hairline">{children}</div>;
}
