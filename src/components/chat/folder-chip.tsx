"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Folder, FolderPlus, Loader2, RefreshCw, X, AlertTriangle } from "lucide-react";
import type { useFolderSync } from "./use-folder-sync";

type Sync = ReturnType<typeof useFolderSync>;

/** Quiet strip above the composer: connected PC folders, their sync freshness,
 *  and a one-click re-grant when a handle's permission lapsed after a reload.
 *  Deliberately calm — a chip row, not a panel. Hidden entirely when the browser
 *  can't do live sync (the fallback import lives in the attach menu instead). */
export function FolderChip({ sync }: { sync: Sync }) {
  const t = useTranslations("chat.folders");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!sync.supported) return null;

  const connect = async () => {
    setBusy(true); setErr("");
    const r = await sync.connect();
    if (!r.ok && r.error) setErr(r.error);
    setBusy(false);
  };

  const freshness =
    sync.phase === "syncing" ? t("syncing")
    : sync.lastSyncedAt ? t("syncedAgo", { ago: relTime(sync.lastSyncedAt, t) })
    : null;

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {sync.folders.map((f) => {
        const lapsed = sync.needReconnect.includes(f.id);
        return (
          <span key={f.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5">
            <Folder className="h-3 w-3 shrink-0" />
            <span className="max-w-[10rem] truncate">{f.name}</span>
            {lapsed ? (
              <button type="button" onClick={() => sync.reconnect(f.id)} className="inline-flex items-center gap-0.5 text-amber-600 hover:underline dark:text-amber-500">
                <RefreshCw className="h-3 w-3" />
                {t("reconnect")}
              </button>
            ) : null}
            <button type="button" onClick={() => sync.remove(f.id)} aria-label={t("disconnect")} className="text-muted-foreground/70 transition-colors hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}

      <button type="button" onClick={connect} disabled={busy} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors hover:text-foreground disabled:opacity-60">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderPlus className="h-3 w-3" />}
        {t("connect")}
      </button>

      {freshness && (
        <span className="inline-flex items-center gap-1">
          {sync.phase === "syncing" && <Loader2 className="h-3 w-3 animate-spin" />}
          {freshness}
          {sync.conflicts > 0 && <span className="text-amber-600 dark:text-amber-500">· {t("conflicts", { n: sync.conflicts })}</span>}
        </span>
      )}

      {(err || sync.phase === "error") && (
        <span className="inline-flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {err || t("syncFailed")}
        </span>
      )}
    </div>
  );
}

/** "just now" / "N min ago" / "N h ago", localized. */
function relTime(ts: number, t: ReturnType<typeof useTranslations>): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return t("justNow");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("minAgo", { n: mins });
  return t("hourAgo", { n: Math.round(mins / 60) });
}
