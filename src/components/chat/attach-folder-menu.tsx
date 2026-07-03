"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileUp, FolderPlus, FolderUp, Folder, RefreshCw, Download, Loader2, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { useFolderSync } from "@/components/chat/use-folder-sync";
import { FOLDER_MAX_FILES, FOLDER_MAX_TOTAL_MB } from "@/lib/folder-bridge/filter";

type FolderSync = ReturnType<typeof useFolderSync>;

/** The paperclip's menu when folder access is on: upload files, or connect/import
 *  a folder from the user's own computer. Lives in the attach menu (not a chip
 *  above the composer) so the composer stays clean when nothing is attached. */
export function AttachFolderMenu({ folders, onUpload, children }: { folders: FolderSync; onUpload: () => void; children: React.ReactNode }) {
  const t = useTranslations("chat.folders");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [imported, setImported] = useState<{ name: string; count: number } | null>(null);

  const connect = async () => {
    setBusy(true); setErr("");
    const r = await folders.connect();
    if (!r.ok) {
      if (r.tooLarge) setErr(t("tooLarge", { count: r.tooLarge.count, mb: r.tooLarge.mb, maxFiles: FOLDER_MAX_FILES, maxMb: FOLDER_MAX_TOTAL_MB }));
      else if (r.error) setErr(r.error);
    }
    setBusy(false);
    if (r.ok) setOpen(false);
  };

  const importFolder = async () => {
    setBusy(true); setErr("");
    try {
      const r = await folders.importFallback();
      if (r) setImported(r);
    } catch {
      setErr(t("syncFailed"));
    }
    setBusy(false);
  };

  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-60";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="outline-none">{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-64 p-1.5">
        <button type="button" className={item} onClick={() => { onUpload(); setOpen(false); }}>
          <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          {t("uploadFiles")}
        </button>

        <div className="my-1 border-t border-border" />

        {folders.supported ? (
          <>
            <button type="button" className={item} onClick={connect} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />}
              {t("connect")}
            </button>

            {folders.folders.map((f) => {
              const lapsed = folders.needReconnect.includes(f.id);
              return (
                <div key={f.id} className="flex items-center gap-2 px-2 py-1 text-sm">
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{f.name}</span>
                  {lapsed && (
                    <button type="button" onClick={() => folders.reconnect(f.id)} className="inline-flex items-center gap-0.5 text-xs text-amber-600 hover:underline dark:text-amber-500">
                      <RefreshCw className="h-3 w-3" />
                      {t("reconnect")}
                    </button>
                  )}
                  <button type="button" onClick={() => folders.remove(f.id)} aria-label={t("disconnect")} className="text-muted-foreground/70 transition-colors hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}

            {folders.folders.length > 0 && (
              <div className="px-2 pt-1 text-xs text-muted-foreground">
                {folders.phase === "syncing" ? (
                  <>
                    <span>{folders.progress ? t(`progress.${folders.progress.phase}`, { done: folders.progress.done, total: folders.progress.total }) : t("syncing")}</span>
                    {folders.progress && folders.progress.total > 0 && (
                      <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-muted">
                        <span className="block h-full bg-primary transition-all" style={{ width: `${Math.round((folders.progress.done / folders.progress.total) * 100)}%` }} />
                      </span>
                    )}
                  </>
                ) : folders.lastSyncedAt ? t("syncedAgo", { ago: rel(folders.lastSyncedAt, t) }) : ""}
                {folders.conflicts > 0 && <span className="text-amber-600 dark:text-amber-500"> · {t("conflicts", { n: folders.conflicts })}</span>}
                {folders.phase !== "syncing" && folders.skipped > 0 && <span className="block text-muted-foreground/70">{t("skipped", { n: folders.skipped })}</span>}
              </div>
            )}
          </>
        ) : (
          <>
            <button type="button" className={item} onClick={importFolder} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FolderUp className="h-4 w-4 shrink-0 text-muted-foreground" />}
              {t("importFolder")}
            </button>
            {imported && (
              <div className="px-2 pt-1 text-xs text-muted-foreground">
                {t("imported", { n: imported.count, name: imported.name })}{" "}
                <a
                  href={`/api/sandbox/files/download-all?chatId=${encodeURIComponent(folders.chatId)}&paths=${encodeURIComponent(imported.name)}`}
                  className="inline-flex items-center gap-1 text-foreground hover:underline"
                >
                  <Download className="h-3 w-3" />
                  {t("downloadZip")}
                </a>
              </div>
            )}
            <div className="px-2 pt-1 text-xs text-muted-foreground/70">{t("unsupportedBrowser")}</div>
          </>
        )}

        {err && <div className="px-2 pt-1 text-xs text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** "just now" / "N min ago" / "N h ago", localized. */
function rel(ts: number, t: ReturnType<typeof useTranslations>): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return t("justNow");
  const mins = Math.round(secs / 60);
  return mins < 60 ? t("minAgo", { n: mins }) : t("hourAgo", { n: Math.round(mins / 60) });
}
