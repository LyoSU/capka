"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PcFolder, SyncProgress } from "@/lib/folder-bridge/bridge";
import type { Manifest } from "@/lib/folder-bridge/plan";
import { type WorkspaceTarget, targetQuery } from "@/lib/workspace-target";

export type FolderSyncPhase = "idle" | "syncing" | "error";
export type ConnectResult = { ok: boolean; error?: string; tooLarge?: { count: number; bytes: number } };

/**
 * Turn-scoped sync for a chat's PC folders. The composer calls pushAll() before a
 * message and pullAll() after the turn; the attach menu renders the state. All the
 * heavy lifting (File System Access, the 3-way plan) is dynamically imported from
 * the bridge so it never touches the SSR/initial bundle. Best-effort: a failure
 * sets "error" but never throws into the send path.
 *
 * `ensureChat` creates the chat's DB row if this is a brand-new chat — a folder
 * row references it, so it must exist before the first attach. For a project
 * target the row always exists, so `ensureChat` is a no-op there.
 *
 * `target` must be referentially stable (memoize it in the caller) — the effects
 * key off it.
 */
export function useFolderSync({ target, ensureChat }: { target: WorkspaceTarget; ensureChat: () => Promise<void> }) {
  const [folders, setFolders] = useState<PcFolder[]>([]);
  const [needReconnect, setNeedReconnect] = useState<string[]>([]);
  const [phase, setPhase] = useState<FolderSyncPhase>("idle");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [supported, setSupported] = useState(true);
  // Whether THIS user may attach a folder at all (the org gate + role), from the
  // server. Undefined until known → the UI shows nothing rather than flashing.
  const [canAttach, setCanAttach] = useState(false);
  // Last-synced manifest per folder NAME — the file browser reads it to badge each
  // workspace file as synced-with-the-PC or pending.
  const [synced, setSynced] = useState<Record<string, Manifest>>({});
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // Serialize syncs: pullAll (post-turn, fire-and-forget) and pushAll (pre-send)
  // both run over the same folder handles + the shared server base row, so two
  // overlapping runs could interleave file ops and clobber the ancestor. Chaining
  // makes the next sync wait for the in-flight one instead of racing it.
  const chain = useRef<Promise<void>>(Promise.resolve());
  // Latest values for the chained closure without re-chaining on every render.
  const canAttachRef = useRef(canAttach);
  canAttachRef.current = canAttach;
  const needReconnectRef = useRef(needReconnect);
  needReconnectRef.current = needReconnect;

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/folders?${targetQuery(target)}`).catch(() => null);
    if (!res?.ok) return;
    const { folders: rows } = (await res.json()) as { folders: { id: string; kind: string; name: string }[] };
    const pc = rows.filter((r) => r.kind === "pc").map((r) => ({ id: r.id, name: r.name }));
    setFolders(pc);
    const { reconnect } = await import("@/lib/folder-bridge/bridge");
    const lapsed: string[] = [];
    for (const f of pc) {
      const state = await reconnect(f.id).catch(() => "gone" as const);
      if (state !== "ok") lapsed.push(f.id);
    }
    setNeedReconnect(lapsed);
  }, [target]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { supportsLiveSync } = await import("@/lib/folder-bridge/bridge");
      if (alive) setSupported(supportsLiveSync());
      // Is folder access on for this user? Cheap, gate-checked server-side.
      const acc = await fetch("/api/folders/access").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (alive) setCanAttach(!!acc?.canAttach);
    })();
    void refresh();
    return () => { alive = false; };
  }, [refresh]);

  // Full sync over every connected folder (skipping those needing a re-grant).
  // Shared by push (pre-message) and pull (post-turn) — a sync is bidirectional
  // and idempotent, so the timing is all that differs.
  const syncAll = useCallback(() => {
    // Chain after any in-flight sync (ignore its rejection — this run is independent).
    const run = chain.current.catch(() => {}).then(async () => {
      // Respect the org gate: if access was turned off, stop syncing entirely
      // (fail-closed) rather than keep streaming workspace files to/from the PC.
      if (!canAttachRef.current) return;
      const live = foldersRef.current.filter((f) => !needReconnectRef.current.includes(f.id));
      if (live.length === 0) return;
      setPhase("syncing");
      try {
        const { sync, syncedManifest } = await import("@/lib/folder-bridge/bridge");
        let totalConflicts = 0;
        let totalSkipped = 0;
        for (const f of live) {
          const r = await sync(target, f, setProgress);
          totalConflicts += r.conflicts;
          totalSkipped += r.skipped;
        }
        // Snapshot the post-sync manifests so the file browser can badge statuses.
        setSynced((prev) => {
          const next = { ...prev };
          for (const f of live) { const m = syncedManifest(f.id); if (m) next[f.name] = m; }
          return next;
        });
        setConflicts(totalConflicts);
        setSkipped(totalSkipped);
        setLastSyncedAt(Date.now());
        setPhase("idle");
      } catch (e) {
        console.error("[folders] sync failed:", e);
        setPhase("error");
      } finally {
        setProgress(null);
      }
    });
    chain.current = run;
    return run;
  }, [target]);

  // Connect a live folder (Chromium): pick → create row → first sync. ensureChat
  // runs inside the bridge, after the picker opens (keeps the user gesture) but
  // before the row is created.
  const connect = useCallback(async (): Promise<ConnectResult> => {
    try {
      const { pickAndCreate } = await import("@/lib/folder-bridge/bridge");
      const folder = await pickAndCreate(target, { ensureChat });
      if (folder) { setLastSyncedAt(Date.now()); await refresh(); }
      return { ok: true };
    } catch (e) {
      // The ceiling error carries counts so the UI can localize (see FolderTooLargeError).
      if (e instanceof Error && e.name === "FolderTooLargeError") {
        const m = e as Error & { count?: number; bytes?: number };
        return { ok: false, tooLarge: { count: m.count ?? 0, bytes: m.bytes ?? 0 } };
      }
      return { ok: false, error: e instanceof Error ? e.message : "Could not attach the folder." };
    }
  }, [target, ensureChat, refresh]);

  // One-shot import (non-Chromium fallback): bulk-upload a picked directory.
  const importFallback = useCallback(async (): Promise<{ name: string; count: number } | null> => {
    await ensureChat();
    const { importFolderFallback } = await import("@/lib/folder-bridge/fallback");
    return importFolderFallback(target);
  }, [target, ensureChat]);

  const reconnectOne = useCallback(async (id: string) => {
    const { requestReconnect } = await import("@/lib/folder-bridge/bridge");
    if (await requestReconnect(id)) {
      setNeedReconnect((prev) => prev.filter((x) => x !== id));
      await syncAll();
    }
  }, [syncAll]);

  const remove = useCallback(async (id: string) => {
    await fetch(`/api/folders/${id}`, { method: "DELETE" }).catch(() => {});
    const { forget } = await import("@/lib/folder-bridge/bridge");
    await forget(id).catch(() => {});
    await refresh();
  }, [refresh]);

  return {
    target, folders, needReconnect, phase, progress, skipped, lastSyncedAt, conflicts, supported, canAttach, synced,
    pushAll: syncAll, pullAll: syncAll, connect, importFallback, reconnect: reconnectOne, remove, refresh,
  };
}
