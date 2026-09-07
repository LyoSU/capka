"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import {
  FileUp, FolderPlus, FolderUp, Folder, FolderOpen, RefreshCw, Download, Loader2, X,
  KeyRound, BookOpen, Blocks, Puzzle, ChevronRight,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { useFolderSync } from "@/components/chat/use-folder-sync";
import { targetQuery } from "@/lib/workspace-target";
import { FOLDER_MAX_FILES, FOLDER_MAX_TOTAL_MB } from "@/lib/folder-bridge/filter";
import { formatSize } from "@/lib/constants";

type FolderSync = ReturnType<typeof useFolderSync>;

/**
 * The composer's "+" menu: everything a person can bring INTO this chat, in one
 * place — files, a folder from their computer (when folder access is on), the
 * credentials the assistant may use here — and, below a rule, the doors to what
 * extends the assistant itself (skills, connectors, plugins). One button rather
 * than a row of icons, so the footer stays legible on a phone and a new option
 * never costs the composer another glyph.
 */
export function ComposerMenu({
  folders,
  onUpload,
  onOpenSecrets,
  children,
}: {
  folders?: FolderSync;
  onUpload: () => void;
  /** Absent for a chat that cannot hold credentials (read-only, no id yet). */
  onOpenSecrets?: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("chat.folders");
  const tMenu = useTranslations("chat.input.menu");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [imported, setImported] = useState<{ name: string; count: number } | null>(null);

  const connect = async () => {
    if (!folders) return;
    setBusy(true); setErr("");
    const r = await folders.connect();
    if (!r.ok) {
      if (r.tooLarge) setErr(t("tooLarge", { count: r.tooLarge.count, size: formatSize(r.tooLarge.bytes), maxFiles: FOLDER_MAX_FILES, maxMb: FOLDER_MAX_TOTAL_MB }));
      else setErr(t("syncFailed"));
    }
    setBusy(false);
    if (r.ok) setOpen(false);
  };

  const importFolder = async () => {
    if (!folders) return;
    setBusy(true); setErr("");
    try {
      const r = await folders.importFallback();
      if (r) setImported(r);
    } catch (e) {
      // Same ceiling as live sync — surface the same localized "too large" message.
      if (e instanceof Error && e.name === "FolderTooLargeError") {
        const m = e as Error & { count?: number; bytes?: number };
        setErr(t("tooLarge", { count: m.count ?? 0, size: formatSize(m.bytes ?? 0), maxFiles: FOLDER_MAX_FILES, maxMb: FOLDER_MAX_TOTAL_MB }));
      } else setErr(t("syncFailed"));
    }
    setBusy(false);
  };

  // Same two repairs as the chips: re-grant a lapsed permission, or point at the
  // folder again when this browser has no handle for it. Never fail silently.
  const reconnect = async (id: string, name: string) => {
    if (!folders) return;
    const r = await folders.reconnect(id);
    if (r === "wrong-folder") toast(t("wrongFolder", { name }));
    else if (r === "failed") toast(t("reconnectFailed"));
  };

  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-hover disabled:opacity-60";
  const icon = "h-4 w-4 shrink-0 text-muted-foreground";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="outline-none">{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-64 p-1.5">
        <button type="button" className={item} onClick={() => { onUpload(); setOpen(false); }}>
          <FileUp className={icon} />
          {t("uploadFiles")}
        </button>

        {folders?.canAttach && (
          folders.supported ? (
            <>
              <button type="button" className={item} onClick={connect} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FolderPlus className={icon} />}
                {t("connect")}
              </button>

              {folders.folders.map((f) => {
                const lapsed = folders.needReconnect.includes(f.id);
                return (
                  <div key={f.id} className="flex items-center gap-2 px-2 py-1 text-sm">
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{f.name}</span>
                    {lapsed && (
                      <button type="button" onClick={() => reconnect(f.id, f.name)} className="inline-flex items-center gap-0.5 text-xs text-amber-600 hover:underline dark:text-amber-500">
                        {folders.reconnectKind[f.id] === "gone" ? (
                          <>
                            <FolderOpen className="h-3 w-3" />
                            {t("chooseAgain")}
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-3 w-3" />
                            {t("reconnect")}
                          </>
                        )}
                      </button>
                    )}
                    <button type="button" onClick={() => folders.remove(f.id)} aria-label={t("disconnect")} className="text-muted-foreground/70 transition-colors hover:text-foreground">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}

              {/* Also while the FIRST folder is copying: there is no chip yet to carry
                  the state, and that first sync is the longest one a person sits through. */}
              {(folders.folders.length > 0 || folders.phase === "syncing") && (
                <div className="px-2 pt-1 text-xs text-muted-foreground">
                  {folders.phase === "syncing" ? (
                    <>
                      <span>{folders.progress ? t(`progress.${folders.progress.phase}`, { done: folders.progress.done, total: folders.progress.total }) : t("syncing")}</span>
                      {folders.progress && folders.progress.total > 0 && (
                        <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-muted">
                          <span className="block h-full bg-primary transition-[width]" style={{ width: `${Math.round((folders.progress.done / folders.progress.total) * 100)}%` }} />
                        </span>
                      )}
                    </>
                  ) : folders.phase === "error" ? (
                    <span className="text-destructive">{t("syncFailed")}</span>
                  ) : folders.phase === "busy-elsewhere" ? (
                    t("busyElsewhere")
                  ) : folders.needReconnect.length > 0 ? (
                    // Honest before flattering: a folder waiting to be reconnected did
                    // not sync, so the last-synced time must not stand in for it.
                    <span className="text-amber-600 dark:text-amber-500">{t("reconnectNeeded", { n: folders.needReconnect.length })}</span>
                  ) : folders.lastSyncedAt ? t("syncedAgo", { ago: rel(folders.lastSyncedAt, locale, t) }) : ""}
                  {folders.conflicts > 0 && <span className="text-warning-text"> · {t("conflicts", { n: folders.conflicts })}</span>}
                  {folders.phase !== "syncing" && folders.skipped > 0 && <span className="block text-muted-foreground/70">{t("skipped", { n: folders.skipped })}</span>}
                </div>
              )}
            </>
          ) : (
            <>
              <button type="button" className={item} onClick={importFolder} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FolderUp className={icon} />}
                {t("importFolder")}
              </button>
              {imported && (imported.count > 0 ? (
                <div className="px-2 pt-1 text-xs text-muted-foreground">
                  {t("imported", { n: imported.count, name: imported.name })}{" "}
                  <a
                    href={`/api/sandbox/files/download-all?${targetQuery(folders.target)}&paths=${encodeURIComponent(imported.name)}`}
                    className="inline-flex items-center gap-1 text-foreground hover:underline"
                  >
                    <Download className="h-3 w-3" />
                    {t("downloadZip")}
                  </a>
                </div>
              ) : (
                // Nothing survived the filter (all skipped/oversized) — no folder was
                // created, so don't offer a zip link to a path that doesn't exist.
                <div className="px-2 pt-1 text-xs text-muted-foreground">{t("nothingImported")}</div>
              ))}
              <div className="px-2 pt-1 text-xs text-muted-foreground/70">{t("unsupportedBrowser")}</div>
            </>
          )
        )}

        {onOpenSecrets && (
          <button type="button" className={item} onClick={() => { setOpen(false); onOpenSecrets(); }}>
            <KeyRound className={icon} />
            {tMenu("secrets")}
          </button>
        )}

        {err && <div className="px-2 pt-1 text-xs text-destructive">{err}</div>}

        <div className="my-1 border-t border-border" />

        {/* Doors, not actions: each opens the settings page that owns the thing. */}
        {[
          { href: "/settings/skills", icon: <BookOpen className={icon} />, label: tMenu("skills") },
          { href: "/settings/connectors", icon: <Blocks className={icon} />, label: tMenu("connectors") },
          { href: "/settings/marketplace", icon: <Puzzle className={icon} />, label: tMenu("plugins") },
        ].map((l) => (
          <Link key={l.href} href={l.href} className={item} onClick={() => setOpen(false)}>
            {l.icon}
            <span className="flex-1">{l.label}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** "3 min ago"-style relative time for the sync footer, localized. */
function rel(ts: number, locale: string, t: ReturnType<typeof useTranslations>): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return t("justNow");
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const mins = Math.round(secs / 60);
  return mins < 60 ? rtf.format(-mins, "minute") : rtf.format(-Math.round(mins / 60), "hour");
}
