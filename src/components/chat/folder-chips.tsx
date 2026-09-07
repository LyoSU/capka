"use client";

import { useTranslations, useLocale } from "next-intl";
import { Folder, RefreshCw, X, Loader2, AlertCircle } from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import type { useFolderSync } from "@/components/chat/use-folder-sync";

type FolderSync = ReturnType<typeof useFolderSync>;

/**
 * The folders connected to this chat, as chips above the composer — beside the
 * attached files, because to the person they are the same kind of thing: "what
 * the assistant can see of mine". Hidden entirely when nothing is connected, so
 * the composer stays clean; once a folder is on, its name, its sync state and the
 * way to disconnect it are in plain sight rather than two clicks into a menu.
 * The menu keeps "connect a folder" — this row only shows what is already there.
 */
export function FolderChips({ folders }: { folders: FolderSync }) {
  const t = useTranslations("chat.folders");
  const locale = useLocale();
  if (folders.folders.length === 0) return null;

  const status =
    folders.phase === "syncing"
      ? folders.progress
        ? t(`progress.${folders.progress.phase}`, { done: folders.progress.done, total: folders.progress.total })
        : t("syncing")
      : folders.phase === "error"
        ? t("syncFailed")
        : folders.lastSyncedAt
          ? t("syncedAgo", { ago: rel(folders.lastSyncedAt, locale, t) })
          : "";

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
      {folders.folders.map((f) => {
        const lapsed = folders.needReconnect.includes(f.id);
        return (
          <div
            key={f.id}
            className={`group/folder flex h-8 max-w-full items-center gap-1.5 rounded-lg border pl-2 pr-1 text-sm ${
              lapsed ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/40"
            }`}
          >
            {folders.phase === "syncing" && !lapsed ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : lapsed ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate">{f.name}</span>
            {lapsed ? (
              // Permission lapsed (a reload, a browser restart): the chip says so and
              // offers the one action that fixes it, in the same amber the menu uses.
              <button
                type="button"
                onClick={() => folders.reconnect(f.id)}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 text-xs text-amber-600 hover:underline dark:text-amber-500"
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                {t("reconnect")}
              </button>
            ) : (
              status && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">· {status}</span>
            )}
            <Hint label={t("disconnect")}>
              <button
                type="button"
                onClick={() => folders.remove(f.id)}
                aria-label={t("disconnect")}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-hover hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Hint>
          </div>
        );
      })}
      {folders.conflicts > 0 && (
        <span className="text-xs text-warning-text">{t("conflicts", { n: folders.conflicts })}</span>
      )}
    </div>
  );
}

/** "3 min ago"-style relative time, localized — the same rule the menu footer uses. */
function rel(ts: number, locale: string, t: ReturnType<typeof useTranslations>): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return t("justNow");
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const mins = Math.round(secs / 60);
  return mins < 60 ? rtf.format(-mins, "minute") : rtf.format(-Math.round(mins / 60), "hour");
}
