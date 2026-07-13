"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowDownUp, ChevronLeft, Cloud, Check, Download, Folder, LayoutGrid, List, Loader2, RefreshCw, Upload, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuCheckboxItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { formatSize } from "@/lib/constants";
import { extOf, fileCategory, fileKind, previewKind, type FileCategory } from "@/lib/file-kinds";
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
  const { open: openPreview } = usePreview();
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>(initialEntries ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

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
  const FileStatus = ({ entry }: { entry: FileEntry }) => {
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
              <FileStatus entry={entry} />
            </span>
            <span className="block text-[10px] uppercase tabular-nums text-muted-foreground">
              {extOf(entry.name) ? `${extOf(entry.name)} · ` : ""}
              {formatSize(entry.size)}
            </span>
          </span>
        </button>
        <a href={downloadUrl(entry.path)} download={entry.name} aria-label={t("download", { name: entry.name })}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-[opacity,color,background-color] hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100">
          <Download className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  };

  const folderTile = (entry: FileEntry) => {
    const { Icon, color, bg } = fileKind(entry.name, true);
    return (
      <FileTile
        key={entry.path}
        name={entry.name}
        onClick={() => setPath(entry.path)}
        thumb={<div className={cn("flex h-full w-full items-center justify-center", bg)}><Icon className={cn("h-7 w-7", color)} /></div>}
      />
    );
  };

  const fileTile = (entry: FileEntry) => (
    <SandboxFileTile key={entry.path} file={fileFor(entry.path, entry.name)} viewable={viewable} />
  );

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

  const gridBody = (
    <div className="px-3">
      {folders.length > 0 && (
        <div>
          {grouped === "1" && (
            <p className="px-1 pb-1 pt-1 text-[11px] font-semibold text-muted-foreground">{t("groupFolders")}</p>
          )}
          <div className="flex flex-wrap gap-2">{folders.map(folderTile)}</div>
        </div>
      )}
      {fileGroups.map((g) => (
        <div key={g.category} className="mt-2">
          {grouped === "1" && (
            <p className="px-1 pb-1 pt-1 text-[11px] font-semibold text-muted-foreground">{groupLabel(g.category)}</p>
          )}
          <div className="flex flex-wrap gap-2">{g.files.map(fileTile)}</div>
        </div>
      ))}
    </div>
  );

  const sortLabel = sortKey === "date" ? t("sortDate") : sortKey === "size" ? t("sortSize") : t("sortName");

  return (
    <div className={cn("flex h-full w-full flex-col", className)}>
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

      {!isEmpty && (
        <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground">
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

          <div className="flex items-center rounded-md border border-border/60 p-0.5">
            <button
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              aria-label={t("viewList")}
              title={t("viewList")}
              className={cn("flex h-6 w-6 items-center justify-center rounded transition-colors",
                view === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setView("grid")}
              aria-pressed={view === "grid"}
              aria-label={t("viewGrid")}
              title={t("viewGrid")}
              className={cn("flex h-6 w-6 items-center justify-center rounded transition-colors",
                view === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-2">
        {path !== "." && (
          <button
            type="button"
            onClick={() => setPath(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".")}
            className="mx-3 mb-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3 w-3" /> {tc("back")}
          </button>
        )}

        {loading && isEmpty && (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" /></div>
        )}

        {error && (
          <div className="px-4 py-4 text-center">
            {error.includes("Session not found") || error.includes("not found") ? (
              <p className="text-xs text-muted-foreground">{t("createHint")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{error}</p>
            )}
          </div>
        )}

        {!error && isEmpty && !loading && (
          <p className="px-4 py-3 text-xs text-muted-foreground">{t("empty")}</p>
        )}

        {!isEmpty && (view === "grid" ? gridBody : listBody)}
      </div>
    </div>
  );
}
