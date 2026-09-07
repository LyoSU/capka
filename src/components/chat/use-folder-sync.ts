"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PcFolder, SyncProgress } from "@/lib/folder-bridge/bridge";
import type { Manifest } from "@/lib/folder-bridge/plan";
import { type WorkspaceTarget, targetQuery } from "@/lib/workspace-target";

/** "busy-elsewhere": every folder in this run was held by another window's sync, so
 *  nothing was reconciled — distinct from "idle", which claims a finished sync. */
export type FolderSyncPhase = "idle" | "syncing" | "error" | "busy-elsewhere";
export type ConnectResult = { ok: boolean; error?: string; tooLarge?: { count: number; bytes: number } };
/** Why a folder is disconnected: "prompt" — the handle is here and only the
 *  permission lapsed (one click re-grants it); "gone" — this browser has no handle at
 *  all (another browser, cleared site data), so the person has to show the folder again. */
export type ReconnectKind = "prompt" | "gone";
export type ReconnectResult = "ok" | "failed" | "cancelled" | "wrong-folder";

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
  // Why each of those is disconnected — the two cases need different actions.
  const [reconnectKind, setReconnectKind] = useState<Record<string, ReconnectKind>>({});
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
  const reconnectKindRef = useRef(reconnectKind);
  reconnectKindRef.current = reconnectKind;

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/folders?${targetQuery(target)}`).catch(() => null);
    if (!res?.ok) return;
    const { folders: rows } = (await res.json()) as { folders: { id: string; kind: string; name: string }[] };
    const pc = rows.filter((r) => r.kind === "pc").map((r) => ({ id: r.id, name: r.name }));
    setFolders(pc);
    const { reconnect } = await import("@/lib/folder-bridge/bridge");
    const lapsed: string[] = [];
    const kinds: Record<string, ReconnectKind> = {};
    for (const f of pc) {
      const state = await reconnect(f.id).catch(() => "gone" as const);
      if (state !== "ok") { lapsed.push(f.id); kinds[f.id] = state; }
    }
    setNeedReconnect(lapsed);
    setReconnectKind(kinds);
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
      // Nothing could run: every folder is waiting to be reconnected. Leave the
      // last-synced time where it is — moving it would tell the person their files
      // are up to date when not one of them was looked at.
      if (live.length === 0) { setPhase("idle"); return; }
      setPhase("syncing");
      try {
        const { sync, syncedManifest } = await import("@/lib/folder-bridge/bridge");
        let totalConflicts = 0;
        let totalSkipped = 0;
        let reconciled = 0; // folders this run actually walked
        let busyElsewhere = 0; // folders another window held a lease on
        for (const f of live) {
          const r = await sync(target, f, setProgress);
          if (r.skippedByLease) { busyElsewhere++; continue; }
          reconciled++;
          totalConflicts += r.conflicts;
          totalSkipped += r.skipped;
        }
        // Snapshot the post-sync manifests so the file browser can badge statuses.
        setSynced((prev) => {
          const next = { ...prev };
          for (const f of live) { const m = syncedManifest(f.id); if (m) next[f.name] = m; }
          return next;
        });
        // A run that reconciled nothing reports nothing: keep the previous counts and
        // timestamp rather than overwriting honest numbers with zeros.
        if (reconciled > 0) {
          setConflicts(totalConflicts);
          setSkipped(totalSkipped);
          setLastSyncedAt(Date.now());
        }
        setPhase(reconciled === 0 && busyElsewhere > 0 ? "busy-elsewhere" : "idle");
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
    // A first sync copies the whole folder and is the longest wait this feature asks
    // for, so it drives the same phase and progress the turn-scoped sync uses. It
    // starts only once real work begins: the directory picker is open before that,
    // and "Syncing…" underneath an open picker would be describing nothing.
    let started = false;
    try {
      const { pickAndCreate } = await import("@/lib/folder-bridge/bridge");
      const folder = await pickAndCreate(target, {
        ensureChat,
        onProgress: (p) => { started = true; setPhase("syncing"); setProgress(p); },
      });
      if (folder) { setLastSyncedAt(Date.now()); await refresh(); }
      if (started) setPhase("idle");
      return { ok: true };
    } catch (e) {
      // The row may already exist even though the first sync failed (it is created
      // before the sync runs). List again so the folder shows up as a chip instead of
      // vanishing — the person picked it, it is attached, and the next turn retries.
      await refresh().catch(() => {});
      // The ceiling error carries counts so the UI can localize (see FolderTooLargeError).
      if (e instanceof Error && e.name === "FolderTooLargeError") {
        // Not a sync failure: the menu says what is too large, so leave the status
        // line alone rather than adding a second, vaguer complaint beside it.
        if (started) setPhase("idle");
        const m = e as Error & { count?: number; bytes?: number };
        return { ok: false, tooLarge: { count: m.count ?? 0, bytes: m.bytes ?? 0 } };
      }
      if (started) setPhase("error");
      return { ok: false, error: e instanceof Error ? e.message : "Could not attach the folder." };
    } finally {
      setProgress(null);
    }
  }, [target, ensureChat, refresh]);

  // One-shot import (non-Chromium fallback): bulk-upload a picked directory.
  const importFallback = useCallback(async (): Promise<{ name: string; count: number } | null> => {
    await ensureChat();
    const { importFolderFallback } = await import("@/lib/folder-bridge/fallback");
    return importFolderFallback(target);
  }, [target, ensureChat]);

  // Two different repairs behind one button. "prompt": the handle is still here and
  // the browser only wants the permission granted again. "gone": there is no handle
  // in this browser at all, so re-asking for permission does nothing — the person has
  // to point at the folder once more. The caller gets the outcome so it can say what
  // happened instead of the button doing nothing.
  const reconnectOne = useCallback(async (id: string): Promise<ReconnectResult> => {
    const folder = foldersRef.current.find((f) => f.id === id);
    if (!folder) return "failed";
    const { requestReconnect, relink } = await import("@/lib/folder-bridge/bridge");
    if (reconnectKindRef.current[id] === "gone") {
      const r = await relink(folder).catch(() => "failed" as const);
      if (r !== "ok") return r;
    } else if (!(await requestReconnect(id).catch(() => false))) {
      return "failed";
    }
    // Update the ref as well as the state: syncAll runs on the next line and reads
    // the ref, which React has not re-rendered yet — without this the folder we just
    // reconnected is filtered straight back out of the run.
    needReconnectRef.current = needReconnectRef.current.filter((x) => x !== id);
    setNeedReconnect(needReconnectRef.current);
    setReconnectKind((prev) => { const next = { ...prev }; delete next[id]; return next; });
    await syncAll();
    return "ok";
  }, [syncAll]);

  const remove = useCallback(async (id: string) => {
    await fetch(`/api/folders/${id}`, { method: "DELETE" }).catch(() => {});
    const { forget } = await import("@/lib/folder-bridge/bridge");
    await forget(id).catch(() => {});
    await refresh();
  }, [refresh]);

  return {
    target, folders, needReconnect, reconnectKind, phase, progress, skipped, lastSyncedAt, conflicts, supported, canAttach, synced,
    pushAll: syncAll, pullAll: syncAll, connect, importFallback, reconnect: reconnectOne, remove, refresh,
  };
}
