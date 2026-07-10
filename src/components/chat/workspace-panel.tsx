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
import { useIsMobile } from "@/hooks/use-mobile";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { formatSize } from "@/lib/constants";
import { extOf, fileCategory, fileKind, previewKind, type FileCategory } from "@/lib/file-kinds";
import { cn } from "@/lib/utils";
import { downloadAllPaths, canDownloadAll } from "./workspace-paths";
import { FileThumb, FileTile, SandboxFileTile, usePreview, type PreviewFile } from "./file-preview";
import type { useFolderSync } from "./use-folder-sync";

type FileEntry = { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: string | null };

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

// ── Panel ────────────────────────────────────────────────────────────────────
//
// The workspace panel is, simply, a file browser over the chat's sandbox — the
// files the agent produced and the user's deliverables. Live progress lives in
// the chat's step rail; pending attachments live as chips above the composer —
// so neither is duplicated here.

export function WorkspacePanel({
  chatId,
  open,
  onClose,
  running,
  revision,
  folderSync,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
  /** True while a task is generating — the panel polls so live writes show up. */
  running: boolean;
  /** Bumps each time a tool call completes (the moment files may have changed),
   *  so the listing refreshes right after the agent writes, not on a timer. */
  revision: number;
  /** PC-folder sync state — badges a connected folder and its files' sync status. */
  folderSync?: ReturnType<typeof useFolderSync>;
}) {
  const t = useTranslations("chat.workspace");
  const tc = useTranslations("common");
  const { open: openPreview } = usePreview();
  const isMobile = useIsMobile();
  // On phones the panel is a full-screen sheet, so the Back gesture should close
  // it rather than leave the chat.
  useBackDismiss(open && isMobile, onClose);
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [view, setView] = usePref<View>("capka.files.view", "list");
  const [sortKey, setSortKey] = usePref<SortKey>("capka.files.sortKey", "name");
  const [sortDir, setSortDir] = usePref<SortDir>("capka.files.sortDir", "asc");
  const [grouped, setGrouped] = usePref<"0" | "1">("capka.files.group", "0");

  // `silent` refreshes (live updates while the agent works) don't toggle the
  // spinner or wipe the list on a transient blip — they just swap in new entries.
  const inFlight = useRef<AbortController | null>(null);
  const fetchFiles = useCallback(async (silent = false) => {
    // Single-flight: a silent poll never stacks on an in-flight request (a slow
    // list under the 4s poll would otherwise pile up and race). A user-driven
    // refresh (folder change) instead aborts the stale request and supersedes it.
    if (silent && inFlight.current) return;
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/sandbox/files?${new URLSearchParams({ chatId, path })}`, { signal: ac.signal });
      const data = await res.json();
      if (ac.signal.aborted) return; // superseded — don't clobber with stale entries
      setError(data.error ?? null);
      setEntries(data.entries ?? []);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      if (!silent) setError(t("loadError"));
    } finally {
      if (inFlight.current === ac) inFlight.current = null;
      if (!silent) setLoading(false);
    }
  }, [chatId, path, t]);

  // Initial load (and on folder change): show the spinner. Only while open — a
  // closed panel shouldn't poll the sandbox.
  useEffect(() => { if (open) fetchFiles(); }, [open, fetchFiles]);

  // Live refresh: silently re-list whenever a tool call completes (the agent just
  // wrote/changed files) and once more when the task stops — so the panel mirrors
  // the sandbox in real time without a polling timer. While a task runs, a light
  // safety-net poll covers writes that don't surface as a tool-result event.
  useEffect(() => {
    if (!open) return;
    fetchFiles(true);
    if (!running) return;
    const id = setInterval(() => fetchFiles(true), 4000);
    return () => clearInterval(id);
  }, [open, running, revision, fetchFiles]);

  // Abort any in-flight listing on unmount so a late response can't setState on a
  // gone component (and the request doesn't linger).
  useEffect(() => () => inFlight.current?.abort(), []);

  // Folders always come first (sorted by name); files obey the chosen sort. When
  // grouping is on, files are then split into Images / Documents / Other, each
  // group keeping the same sort within it.
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
  // The header badge counts everything visible — folders included. Counting only
  // files made a folders-only directory (e.g. a Python venv, or the root itself)
  // report a tiny number next to a long list.
  const entryCount = folders.length + fileCount;
  const isEmpty = entryCount === 0;

  // The files that open in Quick Look, in display order — so ←/→ steps through
  // exactly what's shown, skipping folders and download-only types.
  const viewable: PreviewFile[] = orderedFiles
    .filter((e) => previewKind(e.name) !== null)
    .map((e) => ({ path: e.path, name: e.name, chatId }));

  // ── PC-folder sync badges (Drive-style) ─────────────────────────────────────
  // A top-level folder whose name matches a connected PC folder is "synced". Files
  // inside it get a per-file badge from the last-synced manifest: a workspace file
  // present there (matching size) is in sync with the user's computer.
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

  const downloadUrl = (p: string) => `/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(p)}`;
  const downloadAll = () => {
    const params = new URLSearchParams({ chatId });
    // Archive folders too, not just current-level files — the server's `zip -r`
    // recurses into each folder path, so subfolders are included instead of
    // skipped. See downloadAllPaths.
    downloadAllPaths(entries).forEach((p) => params.append("paths", p));
    const a = document.createElement("a");
    a.href = `/api/sandbox/files/download-all?${params}`;
    a.download = "workspace-files.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const upload = async (fileList: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const form = new FormData();
        form.append("chatId", chatId);
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
    const file: PreviewFile = { path: entry.path, name: entry.name, chatId };
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
    <SandboxFileTile key={entry.path} file={{ path: entry.path, name: entry.name, chatId }} viewable={viewable} />
  );

  const groupLabel = (c: FileCategory) =>
    c === "image" ? t("groupImages") : c === "document" ? t("groupDocuments") : t("groupOther");

  // List body: folders, then file groups (each with a header only when grouping).
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

  // Grid body: same structure, tiles flow-wrapped instead of full-width rows.
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

  // Always mounted so open/close can animate. On mobile it's a fixed overlay that
  // slides in from the right (transform); on desktop (md:static) it's a flex item
  // that grows from 0 → 20rem, pushing the chat smoothly instead of popping in.
  // The inner column keeps a fixed w-80 (shrink-0) so its contents don't reflow
  // mid-animation, and justify-end pins it to the panel's right edge — so the
  // chat slides aside to *reveal* it in place, instead of the column riding the
  // left edge and getting chopped at the window edge while the width animates.
  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "z-40 flex h-full shrink-0 justify-end overflow-hidden border-l bg-card shadow-lg transition-[width,transform] duration-300 ease-out",
        // Mobile: full-screen sheet sliding from the right. Desktop: a flex item
        // that grows 0 → 20rem, pushing the chat instead of overlaying it.
        "fixed inset-y-0 right-0 w-full md:static md:z-auto md:w-80 md:shadow-none",
        open
          ? "translate-x-0 md:w-80"
          : "pointer-events-none translate-x-full md:w-0 md:translate-x-0 md:border-l-0",
      )}
    >
    <div className="flex h-full w-full flex-col md:w-80 md:shrink-0">
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
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onClose} aria-label={t("close")}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Toolbar: sort menu (key + direction + group-by-type) and a list/grid
          toggle. Hidden when there's nothing to arrange. */}
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
    </aside>
  );
}
