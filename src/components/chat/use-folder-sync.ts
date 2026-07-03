"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PcFolder } from "@/lib/folder-bridge/bridge";
import type { Manifest } from "@/lib/folder-bridge/plan";

export type FolderSyncPhase = "idle" | "syncing" | "error";

/**
 * Turn-scoped sync for a chat's PC folders. The composer calls pushAll() before a
 * message and pullAll() after the turn; the attach menu renders the state. All the
 * heavy lifting (File System Access, the 3-way plan) is dynamically imported from
 * the bridge so it never touches the SSR/initial bundle. Best-effort: a failure
 * sets "error" but never throws into the send path.
 *
 * `ensureChat` creates the chat's DB row if this is a brand-new chat — a folder
 * row references it, so it must exist before the first attach.
 */
export function useFolderSync({ chatId, ensureChat }: { chatId: string; ensureChat: () => Promise<void> }) {
  const [folders, setFolders] = useState<PcFolder[]>([]);
  const [needReconnect, setNeedReconnect] = useState<string[]>([]);
  const [phase, setPhase] = useState<FolderSyncPhase>("idle");
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

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/folders?chatId=${encodeURIComponent(chatId)}`).catch(() => null);
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
  }, [chatId]);

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
  const syncAll = useCallback(async () => {
    const live = foldersRef.current.filter((f) => !needReconnect.includes(f.id));
    if (live.length === 0) return;
    setPhase("syncing");
    try {
      const { sync, syncedManifest } = await import("@/lib/folder-bridge/bridge");
      let total = 0;
      for (const f of live) total += (await sync(chatId, f)).conflicts;
      // Snapshot the post-sync manifests so the file browser can badge statuses.
      setSynced((prev) => {
        const next = { ...prev };
        for (const f of live) { const m = syncedManifest(f.id); if (m) next[f.name] = m; }
        return next;
      });
      setConflicts(total);
      setLastSyncedAt(Date.now());
      setPhase("idle");
    } catch {
      setPhase("error");
    }
  }, [chatId, needReconnect]);

  // Connect a live folder (Chromium): pick → create row → first sync. ensureChat
  // runs inside the bridge, after the picker opens (keeps the user gesture) but
  // before the row is created.
  const connect = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { pickAndCreate } = await import("@/lib/folder-bridge/bridge");
      const folder = await pickAndCreate(chatId, { ensureChat });
      if (folder) { setLastSyncedAt(Date.now()); await refresh(); }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Could not attach the folder." };
    }
  }, [chatId, ensureChat, refresh]);

  // One-shot import (non-Chromium fallback): bulk-upload a picked directory.
  const importFallback = useCallback(async (): Promise<{ name: string; count: number } | null> => {
    await ensureChat();
    const { importFolderFallback } = await import("@/lib/folder-bridge/fallback");
    return importFolderFallback(chatId);
  }, [chatId, ensureChat]);

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
    chatId, folders, needReconnect, phase, lastSyncedAt, conflicts, supported, canAttach, synced,
    pushAll: syncAll, pullAll: syncAll, connect, importFallback, reconnect: reconnectOne, remove, refresh,
  };
}
