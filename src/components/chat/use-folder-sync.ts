"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PcFolder } from "@/lib/folder-bridge/bridge";

export type FolderSyncPhase = "idle" | "syncing" | "error";

/**
 * Turn-scoped sync for a chat's PC folders. The composer calls pushAll() before a
 * message and pullAll() after the turn; the FolderChip renders the state. All the
 * heavy lifting (File System Access, the 3-way plan) is dynamically imported from
 * the bridge so it never touches the SSR/initial bundle. Best-effort: a failure
 * sets "error" but never throws into the send path.
 */
export function useFolderSync(chatId: string) {
  const [folders, setFolders] = useState<PcFolder[]>([]);
  const [needReconnect, setNeedReconnect] = useState<string[]>([]);
  const [phase, setPhase] = useState<FolderSyncPhase>("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [supported, setSupported] = useState(true);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/folders?chatId=${encodeURIComponent(chatId)}`).catch(() => null);
    if (!res?.ok) return;
    const { folders: rows } = (await res.json()) as { folders: { id: string; kind: string; name: string }[] };
    const pc = rows.filter((r) => r.kind === "pc").map((r) => ({ id: r.id, name: r.name }));
    setFolders(pc);
    // Which stored handles have lapsed permission (need a one-click re-grant).
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
    })();
    void refresh();
    return () => { alive = false; };
  }, [refresh]);

  // Run a full sync over every connected folder (skipping those needing a
  // re-grant). Shared by push (pre-message) and pull (post-turn) — a sync is
  // bidirectional and idempotent, so the timing is all that differs.
  const syncAll = useCallback(async () => {
    const live = foldersRef.current.filter((f) => !needReconnect.includes(f.id));
    if (live.length === 0) return;
    setPhase("syncing");
    try {
      const { sync } = await import("@/lib/folder-bridge/bridge");
      let total = 0;
      for (const f of live) {
        const r = await sync(chatId, f);
        total += r.conflicts;
      }
      setConflicts(total);
      setLastSyncedAt(Date.now());
      setPhase("idle");
    } catch {
      setPhase("error");
    }
  }, [chatId, needReconnect]);

  const connect = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { pickAndCreate } = await import("@/lib/folder-bridge/bridge");
      const folder = await pickAndCreate(chatId);
      if (folder) { setLastSyncedAt(Date.now()); await refresh(); }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Could not attach the folder." };
    }
  }, [chatId, refresh]);

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
    folders, needReconnect, phase, lastSyncedAt, conflicts, supported,
    pushAll: syncAll, pullAll: syncAll, connect, reconnect: reconnectOne, remove, refresh,
  };
}
