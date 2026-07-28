"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDownUp, ChevronRight, Cloud, Check, Download, FileWarning, Folder, LayoutGrid, List, Loader2, RefreshCw, Trash2, Upload, X,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuCheckboxItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatSize } from "@/lib/constants";
import { fileCategory, fileKind, previewKind, type FileCategory } from "@/lib/file-kinds";
import { cn } from "@/lib/utils";
import { type WorkspaceTarget, targetQuery } from "@/lib/workspace-target";
import { canDownloadAll } from "./workspace-paths";
import { FileThumb, FileTile, SandboxFileTile, usePreview, type PreviewFile } from "./file-preview";
import type { useFolderSync } from "./use-folder-sync";

export type FileEntry = { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: string | null };

type View = "list" | "grid";
type SortKey = "name" | "date" | "size";
type SortDir = "asc" | "desc";

// Categories render in this order when grouping is on; "other" last.
const CATEGORY_ORDER: FileCategory[] = ["image", "document", "other"];

/**
 * A view preference persisted to localStorage, read via useSyncExternalStore so
 * it has a stable SSR snapshot (`fallback`) and adopts the stored value on the
 * client with no hydration mismatch. Writing dispatches a `storage` event so the
 * same document re-renders (the native event only fires across tabs).
 */
function subscribePref(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}
function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    subscribePref,
    () => (localStorage.getItem(key) as T | null) ?? fallback,
    () => fallback,
  );
  const set = useCallback((next: T) => {
    try {
      localStorage.setItem(key, next);
      window.dispatchEvent(new StorageEvent("storage", { key }));
    } catch {}
  }, [key]);
  return [value, set];
}

// ── WorkspaceBrowser ──────────────────────────────────────────────────────────
//
// The reusable file browser over a workspace — the files the agent produced and
// the user's deliverables. Addressed by a WorkspaceTarget (a chat's own workspace,
// or a project's shared one) so it serves both the chat's sliding WorkspacePanel
// and the project hub's Files tab from one implementation. List/preview/upload/
// download all work off the host disk with no live container.

export function WorkspaceBrowser({
  target,
  active = true,
  running = false,
  revision = 0,
  folderSync,
  onClose,
  className,
  initialEntries,
  onLoaded,
}: {
  target: WorkspaceTarget;
  /** Whether the browser is actually visible — the chat panel keeps it mounted
   *  (inside its sliding aside) even when closed, so gate polling on this to avoid
   *  hitting the sandbox for a hidden panel. Defaults true for always-visible hosts. */
  active?: boolean;
  /** Root-level entries the host already fetched (the hub, for its file count) —
   *  used to seed the initial view so this browser doesn't re-fetch the same listing. */
  initialEntries?: FileEntry[];
  /** Reports the root listing after each root fetch, so the host can keep a derived
   *  count (e.g. the hub overview) fresh without its own extra request. */
  onLoaded?: (entries: FileEntry[]) => void;
  /** True while a task is generating — the browser polls so live writes show up. */
  running?: boolean;
  /** Bumps each time a tool call completes (files may have changed) so the listing
   *  refreshes right after the agent writes, not on a timer. */
  revision?: number;
  /** PC-folder sync state — badges a connected folder and its files' sync status. */
  folderSync?: ReturnType<typeof useFolderSync>;
  /** When set, renders a close button (the chat panel); omitted in the hub tab. */
  onClose?: () => void;
  className?: string;
}) {
  const t = useTranslations("chat.workspace");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { open: openPreview } = usePreview();
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>(initialEntries ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dropping, setDropping] = useState(false);

  // Intl.RelativeTimeFormat gives correct units and plurals per locale (incl.
  // Ukrainian) for free, so no hand-kept strings. Floored at one minute: a file
  // the agent wrote a second ago reading "this minute" is odd phrasing, and
  // "1 minute ago" is honest enough at this granularity.
  const ago = useMemo(() => {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return (iso: string) => {
      const mins = Math.round(Math.max(0, Date.now() - Date.parse(iso)) / 60000);
      if (mins < 60) return rtf.format(-Math.max(1, mins), "minute");
      const hours = Math.round(mins / 60);
      if (hours < 24) return rtf.format(-hours, "hour");
      const days = Math.round(hours / 24);
      return days < 30 ? rtf.format(-days, "day") : rtf.format(-Math.round(days / 30), "month");
    };
  }, [locale]);

  const [view, setView] = usePref<View>("capka.files.view", "list");
  const [sortKey, setSortKey] = usePref<SortKey>("capka.files.sortKey", "name");
  const [sortDir, setSortDir] = usePref<SortDir>("capka.files.sortDir", "asc");
  const [grouped, setGrouped] = usePref<"0" | "1">("capka.files.group", "0");

  const query = targetQuery(target);
  // Build a PreviewFile addressed at this browser's target (chat or project).
  const fileFor = useCallback(
    (p: string, name: string): PreviewFile =>
      target.kind === "chat" ? { path: p, name, chatId: target.chatId } : { path: p, name, projectId: target.projectId },
    [target],
  );

  // onLoaded via a ref so it isn't a fetchFiles dependency (an unmemoized host
  // callback would otherwise re-create fetchFiles every render → refetch loop).
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // `silent` refreshes (live updates while the agent works) don't toggle the
  // spinner or wipe the list on a transient blip — they just swap in new entries.
  const inFlight = useRef<AbortController | null>(null);
  const fetchFiles = useCallback(async (silent = false) => {
    if (silent && inFlight.current) return;
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/sandbox/files?${query}&path=${encodeURIComponent(path)}`, { signal: ac.signal });
      const data = await res.json();
      if (ac.signal.aborted) return; // superseded — don't clobber with stale entries
      setError(data.error ?? null);
      setEntries(data.entries ?? []);
      if (path === ".") onLoadedRef.current?.(data.entries ?? []); // keep the host's count fresh
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      if (!silent) setError(t("loadError"));
    } finally {
      if (inFlight.current === ac) inFlight.current = null;
      if (!silent) setLoading(false);
    }
  }, [query, path, t]);

  // When the host seeded the root listing (initialEntries), skip BOTH first fetches
  // exactly once so the same view isn't re-fetched on mount — the seed is consumed
  // by the live-refresh effect below. Navigation/upload/poll still fetch normally.
  const seededRef = useRef(initialEntries != null);

  // Initial load and on folder change: show the spinner. Only while visible — a
  // hidden panel shouldn't poll the sandbox.
  useEffect(() => {
    if (!active) return;
    if (seededRef.current) return; // seeded root — don't re-fetch it
    fetchFiles();
  }, [active, fetchFiles]);

  // Live refresh: silently re-list whenever a tool call completes (the agent just
  // wrote/changed files) and once more when the task stops. While a task runs, a
  // light safety-net poll covers writes that don't surface as a tool-result event.
  useEffect(() => {
    if (!active) return;
    if (seededRef.current) { seededRef.current = false; return; } // consume the seed once
    fetchFiles(true);
    if (!running) return;
    const id = setInterval(() => fetchFiles(true), 4000);
    return () => clearInterval(id);
  }, [active, running, revision, fetchFiles]);

  // Abort any in-flight listing on unmount.
  useEffect(() => () => inFlight.current?.abort(), []);

  // Folders first (by name); files obey the chosen sort. With grouping on, files
  // split into Images / Documents / Other, each keeping the same sort.
  const { folders, fileGroups, orderedFiles } = useMemo(() => {
    const visible = entries.filter((e) => !e.name.startsWith("."));
    const folders = visible
      .filter((e) => e.isDirectory)
      .sort((a, b) => a.name.localeCompare(b.name));

    const cmp = (a: FileEntry, b: FileEntry) => {
      let r: number;
      if (sortKey === "size") r = a.size - b.size;
      else if (sortKey === "date") r = (a.modifiedAt ? Date.parse(a.modifiedAt) : 0) - (b.modifiedAt ? Date.parse(b.modifiedAt) : 0);
      else r = a.name.localeCompare(b.name);
      return sortDir === "asc" ? r : -r;
    };
    const files = visible.filter((e) => !e.isDirectory).sort(cmp);

    const fileGroups: { category: FileCategory; files: FileEntry[] }[] =
      grouped === "1"
        ? CATEGORY_ORDER
            .map((category) => ({ category, files: files.filter((f) => fileCategory(f.name) === category) }))
            .filter((g) => g.files.length > 0)
        : [{ category: "other" as FileCategory, files }];

    const orderedFiles = fileGroups.flatMap((g) => g.files);
    return { folders, fileGroups, orderedFiles };
  }, [entries, sortKey, sortDir, grouped]);

  const fileCount = orderedFiles.length;
  const entryCount = folders.length + fileCount;
  const isEmpty = entryCount === 0;

  // The files that open in Quick Look, in display order.
  const viewable: PreviewFile[] = orderedFiles
    .filter((e) => previewKind(e.name) !== null)
    .map((e) => fileFor(e.path, e.name));

  // ── PC-folder sync badges (Drive-style) ─────────────────────────────────────
  const syncedNames = useMemo(() => new Set(folderSync?.folders.map((f) => f.name) ?? []), [folderSync?.folders]);
  const topSeg = path === "." ? null : path.split("/")[0];
  const activeBase = topSeg && syncedNames.has(topSeg) ? folderSync?.synced[topSeg] : undefined;
  const syncingNow = folderSync?.phase === "syncing";
  const isSyncedFolder = (entry: FileEntry) => path === "." && syncedNames.has(entry.name);
  const fileStatus = (entry: FileEntry): "synced" | "pending" | "syncing" | null => {
    if (!activeBase || !topSeg) return null;
    if (syncingNow) return "syncing";
    const rel = entry.path.startsWith(`${topSeg}/`) ? entry.path.slice(topSeg.length + 1) : entry.name;
    const b = activeBase[rel];
    return b && b.size === entry.size ? "synced" : "pending";
  };
  // A plain render function, NOT a component: declared in the render body it would
  // be a fresh component type every render, and React would remount every badge
  // (losing the spinner's animation) on each live refresh.
  const statusIcon = (entry: FileEntry) => {
    const s = fileStatus(entry);
    if (!s) return null;
    if (s === "syncing") return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-label={t("statusSyncing")} />;
    if (s === "synced") return <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-500" aria-label={t("statusSynced")} />;
    return <Cloud className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-label={t("statusPending")} />;
  };

  const downloadUrl = (p: string) => `/api/sandbox/files/download?${query}&path=${encodeURIComponent(p)}`;
  // Download EVERYTHING via the controller archive (a complete tar.gz streamed from
  // the workspace root), not a zip of the paths the client happened to enumerate.
  const downloadAll = () => {
    const a = document.createElement("a");
    a.href = `/api/sandbox/files/archive?${query}`;
    a.download = "workspace.tar.gz";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const upload = async (fileList: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const form = new FormData();
        if (target.kind === "chat") form.append("chatId", target.chatId);
        else form.append("projectId", target.projectId);
        form.append("path", path);
        form.append("file", file);
        const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
        if (!res.ok) toast.error(t("uploadFailed", { name: file.name }));
      }
      fetchFiles();
    } finally {
      setUploading(false);
    }
  };

  // Only ever reached from the confirm dialog's action button — the row's trash
  // icon just stages the entry, so a stray click can't delete anything.
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/sandbox/files?${query}&path=${encodeURIComponent(pendingDelete.path)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) toast.error(t("deleteFailed"));
      else toast.success(t("deleted"));
      fetchFiles();
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  // ── Row / tile renderers (shared by list and grid layouts) ──────────────────
  const folderRow = (entry: FileEntry) => {
    const { Icon, color, bg } = fileKind(entry.name, true);
    return (
      <div key={entry.path} className="group flex items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-accent/40">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
          <Icon className={`h-4 w-4 ${color}`} />
        </div>
        <button type="button" onClick={() => setPath(entry.path)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">{entry.name}</p>
        </button>
        {isSyncedFolder(entry) && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title={t("syncedFolder")}>
            {syncingNow ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {syncingNow && folderSync?.progress && folderSync.progress.total > 0
              ? `${folderSync.progress.done}/${folderSync.progress.total}`
              : t("synced")}
          </span>
        )}
      </div>
    );
  };

  const fileRow = (entry: FileEntry) => {
    const file = fileFor(entry.path, entry.name);
    const canView = previewKind(entry.name) !== null;
    return (
      <div key={entry.path} className="group flex items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-accent/40">
        <button
          type="button"
          disabled={!canView}
          onClick={() => openPreview(viewable, viewable.findIndex((v) => v.path === entry.path))}
          className="flex min-w-0 flex-1 items-center gap-3 text-left enabled:cursor-pointer"
        >
          <FileThumb file={file} className="h-9 w-9 shrink-0 rounded-lg" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-sm text-foreground/90">{entry.name}</span>
              {statusIcon(entry)}
            </span>
            {/* No extension here — the thumbnail to the left already carries it on
                its badge, and printing it twice in one row reads as noise. */}
            <span className="block truncate text-[10px] tabular-nums text-muted-foreground">
              {formatSize(entry.size)}
              {entry.modifiedAt ? ` · ${t("modified", { ago: ago(entry.modifiedAt) })}` : ""}
            </span>
          </span>
        </button>
        <a href={downloadUrl(entry.path)} download={entry.name} aria-label={t("download", { name: entry.name })}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-[opacity,color,background-color] hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100">
          <Download className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          onClick={() => setPendingDelete(entry)}
          aria-label={t("deleteTitle", { name: entry.name })}
          title={t("delete")}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-[opacity,color,background-color] hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  // The sync badge as a tile corner overlay — the same verdict the list row shows,
  // so flipping to grid never silently drops a file's status.
  const tileBadge = (label: string, icon: React.ReactNode) => (
    <span
      aria-label={label}
      title={label}
      className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background/90 ring-1 ring-border/60"
    >
      {icon}
    </span>
  );

  const folderTile = (entry: FileEntry) => {
    const { Icon, color, bg } = fileKind(entry.name, true);
    return (
      <FileTile
        key={entry.path}
        name={entry.name}
        className="w-full"
        onClick={() => setPath(entry.path)}
        thumb={<div className={cn("flex h-full w-full items-center justify-center", bg)}><Icon className={cn("h-7 w-7", color)} /></div>}
        overlay={isSyncedFolder(entry)
          ? tileBadge(t("syncedFolder"), syncingNow
            ? <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
            : <RefreshCw className="h-2.5 w-2.5 text-primary" />)
          : undefined}
      />
    );
  };

  const fileTile = (entry: FileEntry) => {
    const s = fileStatus(entry);
    return (
      <SandboxFileTile
        key={entry.path}
        file={fileFor(entry.path, entry.name)}
        viewable={viewable}
        className="w-full"
        overlay={s
          ? tileBadge(
            s === "syncing" ? t("statusSyncing") : s === "synced" ? t("statusSynced") : t("statusPending"),
            s === "syncing" ? <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
              : s === "synced" ? <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-500" />
                : <Cloud className="h-2.5 w-2.5 text-muted-foreground/70" />,
          )
          : undefined}
      />
    );
  };

  const groupLabel = (c: FileCategory) =>
    c === "image" ? t("groupImages") : c === "document" ? t("groupDocuments") : t("groupOther");

  const listBody = (
    <div className="space-y-0.5 px-3">
      {folders.length > 0 && grouped === "1" && (
        <p className="px-1 pb-0.5 pt-2 text-[11px] font-semibold text-muted-foreground">{t("groupFolders")}</p>
      )}
      {folders.map(folderRow)}
      {fileGroups.map((g) => (
        <div key={g.category} className="space-y-0.5">
          {grouped === "1" && (
            <p className="px-1 pb-0.5 pt-2 text-[11px] font-semibold text-muted-foreground">{groupLabel(g.category)}</p>
          )}
          {g.files.map(fileRow)}
        </div>
      ))}
    </div>
  );

  // A real grid, so tiles line up flush at both widths this browser lives at (the
  // 320px chat panel and the project hub's full-width Files tab) instead of the
  // ragged right edge flex-wrap left. The tiles are told to fill their track
  // (`className="w-full"`); their default is the fixed square the wrapping rows
  // in chat history and the composer still want.
  const gridCols = "grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2";

  const gridBody = (
    <div className="px-3">
      {folders.length > 0 && (
        <div>
          {grouped === "1" && (
            <p className="px-1 pb-1 pt-1 text-[11px] font-semibold text-muted-foreground">{t("groupFolders")}</p>
          )}
          <div className={gridCols}>{folders.map(folderTile)}</div>
        </div>
      )}
      {fileGroups.map((g) => (
        <div key={g.category} className="mt-2">
          {grouped === "1" && (
            <p className="px-1 pb-1 pt-1 text-[11px] font-semibold text-muted-foreground">{groupLabel(g.category)}</p>
          )}
          <div className={gridCols}>{g.files.map(fileTile)}</div>
        </div>
      ))}
    </div>
  );

  const sortLabel = sortKey === "date" ? t("sortDate") : sortKey === "size" ? t("sortSize") : t("sortName");

  const segments = path === "." ? [] : path.split("/");
  // A 320px panel can't hold a deep path, so keep the root plus the two levels
  // nearest the user and elide the middle — better than wrapping to three lines.
  const crumbs = segments.length > 2 ? segments.slice(-2) : segments;

  return (
    <div
      className={cn("relative flex h-full w-full flex-col", className)}
      // Dropping files onto the panel is the obvious gesture for a file browser.
      // stopPropagation matters: the composer's FileDropZone listens on `window`,
      // so without it the same files would ALSO be staged as a chat attachment.
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return; // dragged text/links aren't uploads
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault(); // preventDefault on dragover is what makes this a valid drop target
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        // dragleave also fires when the pointer crosses into a child, so only a
        // move to something outside the panel counts as leaving.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(e) => {
        // preventDefault unconditionally and first: a drop this handler bails out of
        // is still a drop the browser would act on, and its default for a dragged
        // link is to navigate away from the chat.
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/50 bg-background/85 text-center">
          <Upload className="h-6 w-6 text-primary" aria-hidden />
          <p className="text-sm font-medium">{t("dropHere")}</p>
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:pt-3">
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-tight">
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{t("title")}</span>
          {entryCount > 0 && (
            <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">{entryCount}</span>
          )}
        </h3>
        <label title={t("upload")} aria-label={t("upload")}>
          <input type="file" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
          <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Upload className={`h-3.5 w-3.5 ${uploading ? "animate-pulse" : ""}`} />
          </div>
        </label>
        {canDownloadAll(folders.length, fileCount) && (
          <button onClick={downloadAll} title={t("downloadAll")} aria-label={t("downloadAll")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
        {onClose && (
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onClose} aria-label={t("close")}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Always mounted: gating this bar on "has files" made it pop in the moment
          the first file landed and shove the list down. With nothing to sort the
          sort menu is simply disabled. */}
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={fileCount === 0}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
            {sortLabel}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <DropdownMenuRadioItem value="name">{t("sortName")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="date">{t("sortDate")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="size">{t("sortSize")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={sortDir === "desc"} onCheckedChange={(c) => setSortDir(c ? "desc" : "asc")}>
              {t("sortDesc")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={grouped === "1"} onCheckedChange={(c) => setGrouped(c ? "1" : "0")}>
              {t("groupByType")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToggleGroup
          value={[view]}
          onValueChange={(values) => {
            if (values.length > 0) setView(values[0] as View);
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="list" aria-label={t("viewList")} title={t("viewList")} className="h-6 w-6">
            <List className="h-3.5 w-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="grid" aria-label={t("viewGrid")} title={t("viewGrid")} className="h-6 w-6">
            <LayoutGrid className="h-3.5 w-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {segments.length > 0 && (
          // The whole trail, not just "back": inside a nested folder the user needs
          // to see where they are and jump out in one step. A named <nav>, so the
          // row announces as a path rather than as a handful of loose buttons.
          <nav aria-label={t("breadcrumb")} className="mx-3 mb-1 flex min-w-0 items-center gap-0.5 overflow-hidden text-[11px] text-muted-foreground">
            <button type="button" onClick={() => setPath(".")} className="shrink-0 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground">
              {t("root")}
            </button>
            {crumbs.length < segments.length && (
              <>
                <ChevronRight className="h-3 w-3 shrink-0 opacity-50" aria-hidden />
                <span className="shrink-0 px-0.5" aria-hidden>…</span>
              </>
            )}
            {crumbs.map((seg, i) => {
              const depth = segments.length - crumbs.length + i;
              const isLast = depth === segments.length - 1;
              return (
                <span key={depth} className="flex min-w-0 items-center gap-0.5">
                  <ChevronRight className="h-3 w-3 shrink-0 opacity-50" aria-hidden />
                  {isLast ? (
                    <span className="truncate px-1 py-0.5 font-medium text-foreground" aria-current="page">{seg}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPath(segments.slice(0, depth + 1).join("/"))}
                      className="truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                    >
                      {seg}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        )}

        {/* Skeletons, not a spinner: the rows appear where the files will be, so the
            panel doesn't visibly re-lay-out the instant the listing lands. */}
        {loading && isEmpty && (
          <div className="px-3" aria-hidden>
            {view === "grid" ? (
              <div className={gridCols}>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="space-y-1">
                    <Skeleton className="aspect-square w-full rounded-xl" />
                    <Skeleton className="mx-auto h-2 w-3/4" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-0.5">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 px-1 py-1">
                    <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-1/2" />
                      <Skeleton className="h-2 w-1/4 bg-muted/60" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Three states, one shape. "No workspace yet" is not a failure — it is what
            a brand-new chat looks like — yet it used to render through the error
            branch as a grey 12px line directly above the styled empty state, so the
            calmest moment in the panel looked like the broken one. */}
        {error ? (
          error.includes("Session not found") || error.includes("not found") ? (
            <PanelNotice icon={Folder} title={t("notReadyTitle")} hint={t("createHint")} />
          ) : (
            // The raw controller string stays in `title`, not on screen: this panel is
            // read by people who did not ask for a stack trace, and a friendly
            // sentence is the house rule for every failure they can see.
            <PanelNotice icon={FileWarning} title={t("loadError")} hint={t("loadErrorHint")} detail={error} />
          )
        ) : isEmpty && !loading ? (
          <PanelNotice icon={Folder} title={t("emptyTitle")} hint={t("emptyHint")}>
            {/* sr-only rather than hidden so the input stays keyboard-reachable and
                the label names it — a display:none input can't be tabbed to. */}
            <label className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-2 cursor-pointer focus-within:ring-2 focus-within:ring-ring")}>
              <input type="file" multiple className="sr-only" onChange={(e) => e.target.files && upload(e.target.files)} />
              <Upload className="h-3.5 w-3.5" aria-hidden />
              {t("upload")}
            </label>
          </PanelNotice>
        ) : null}

        {!isEmpty && (view === "grid" ? gridBody : listBody)}
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle", { name: pendingDelete?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The panel's one full-height message: a muted glyph, a plain sentence, an optional
 * hint, and room for a single action.
 *
 * One shape for "nothing here yet", "no workspace yet" and "couldn't load", because
 * a user cannot tell those three apart by severity and shouldn't have to — what they
 * need is the same each time: what this space is for, and what to do next. `detail`
 * carries an operator-facing string into the DOM without putting it on screen.
 */
function PanelNotice({
  icon: Icon, title, hint, detail, children,
}: {
  icon: typeof Folder;
  title: string;
  hint?: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" title={detail}>
      <Icon className="h-8 w-8 text-muted-foreground/30" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-[16rem] text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}
