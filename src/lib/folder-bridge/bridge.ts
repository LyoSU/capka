/**
 * Browser folder bridge for PC folders: pick a directory, persist its handle, and
 * sync it with the workspace copy (/workspace/<name>) around agent turns. All the
 * decision-making is the pure planner (plan.ts); this file is the browser-only
 * plumbing — File System Access handles, IndexedDB, and the file API calls.
 *
 * Not unit-tested (handle I/O + IndexedDB have no vitest surface); the pure parts
 * it leans on — the 3-way planner and the hash prefilter — are. Best-effort by
 * design: a sync failure warns, it never blocks the turn (see chat-input).
 */

import { planSync, type Manifest } from "./plan";
import {
  walkLocal, hashCandidates, mergeHashed, sha256Hex,
  readLocalFile, writeLocalFile, deleteLocalFile,
  type DirHandle, type HashedManifest,
} from "./local-fs";

export type PcFolder = { id: string; name: string };

declare global {
  interface Window {
    showDirectoryPicker?(opts?: { mode?: "read" | "readwrite"; id?: string }): Promise<DirHandle>;
  }
}

/** Chromium-desktop only. Firefox/Safari have refused the directory picker, so the
 *  UI falls back to a one-shot import + zip download there (see B5). */
export function supportsLiveSync(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

// ── IndexedDB handle store (hand-rolled — no dep for ~1 store) ────────────────

const DB_NAME = "capka-folders";
const STORE = "handles";

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    };
  });
}

const saveHandle = (id: string, handle: DirHandle) => withStore<void>("readwrite", (s) => s.put(handle, id));
const loadHandle = (id: string) => withStore<DirHandle | undefined>("readonly", (s) => s.get(id));
const dropHandle = (id: string) => withStore<void>("readwrite", (s) => s.delete(id));

// In-memory base + last-local per folder for this tab. Base is the 3-way merge
// ancestor; kept in memory (persisted best-effort to the server row for
// forward-compat). After a page reload base is empty → the first sync treats both
// sides as first-seen (union + LWW on genuine content clashes — no data loss).
const bases = new Map<string, Manifest>();
const lastLocal = new Map<string, HashedManifest>();

// ── File API (workspace side, /workspace/<name>/…) ───────────────────────────

async function serverManifest(chatId: string, name: string): Promise<Manifest> {
  const res = await fetch(`/api/sandbox/files?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(name)}&depth=20`);
  if (!res.ok) return {};
  const { entries } = (await res.json()) as { entries?: { path: string; isDirectory: boolean; size: number; modifiedAt: string | null }[] };
  const m: Manifest = {};
  for (const e of entries ?? []) {
    if (e.isDirectory) continue;
    // Entries may come back relative to the queried dir or to the workspace root;
    // normalize to a path relative to the folder.
    const rel = e.path.startsWith(`${name}/`) ? e.path.slice(name.length + 1) : e.path;
    m[rel] = { mtime: e.modifiedAt ? Date.parse(e.modifiedAt) : 0, size: e.size };
  }
  return m;
}

async function uploadToWorkspace(chatId: string, name: string, rel: string, blob: Blob): Promise<void> {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? `${name}/${rel.slice(0, slash)}` : name;
  const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
  const form = new FormData();
  form.append("chatId", chatId);
  form.append("path", dir);
  form.append("file", new File([blob], filename));
  const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error("upload failed");
}

async function downloadFromWorkspace(chatId: string, name: string, rel: string): Promise<Blob> {
  const res = await fetch(`/api/sandbox/files/download?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(`${name}/${rel}`)}`);
  if (!res.ok) throw new Error("download failed");
  return res.blob();
}

async function deleteFromWorkspace(chatId: string, name: string, rel: string): Promise<void> {
  await fetch(`/api/sandbox/files?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(`${name}/${rel}`)}`, { method: "DELETE" });
}

// ── Local hashing (with the prefilter) ───────────────────────────────────────

async function localHashed(handle: DirHandle, folderId: string): Promise<HashedManifest> {
  const stats = await walkLocal(handle);
  const prev = lastLocal.get(folderId) ?? {};
  const fresh: Record<string, string> = {};
  for (const path of hashCandidates(stats, prev)) fresh[path] = await sha256Hex(await readLocalFile(handle, path));
  const merged = mergeHashed(stats, prev, fresh);
  lastLocal.set(folderId, merged);
  return merged;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Open the directory picker, create the folder row, persist the handle, and run a
 *  first sync. Returns the created folder, or null if the user dismissed the picker. */
export async function pickAndCreate(chatId: string, name?: string): Promise<PcFolder | null> {
  let handle: DirHandle;
  try {
    handle = await window.showDirectoryPicker!({ mode: "readwrite" });
  } catch {
    return null; // user cancelled the picker
  }
  const res = await fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, name: name || handle.name }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Could not attach the folder.");
  const { folder } = (await res.json()) as { folder: PcFolder };
  await saveHandle(folder.id, handle);
  await sync(chatId, folder);
  return folder;
}

/** After a reload the handle survives in IndexedDB but its permission may have
 *  lapsed — a plain tab needs one user-gesture re-grant per session. */
export async function reconnect(folderId: string): Promise<"ok" | "prompt" | "gone"> {
  const handle = await loadHandle(folderId);
  if (!handle) return "gone";
  try {
    const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    return state === "granted" ? "ok" : "prompt";
  } catch {
    return "gone";
  }
}

/** Re-request permission for a stored handle (must be called from a user gesture). */
export async function requestReconnect(folderId: string): Promise<boolean> {
  const handle = await loadHandle(folderId);
  if (!handle) return false;
  const state = (await handle.requestPermission?.({ mode: "readwrite" })) ?? "granted";
  return state === "granted";
}

/** Forget a folder's handle locally (called when the row is deleted). */
export async function forget(folderId: string): Promise<void> {
  bases.delete(folderId);
  lastLocal.delete(folderId);
  await dropHandle(folderId).catch(() => {});
}

/** Full bidirectional reconcile between the local folder and /workspace/<name>.
 *  push (before a message) and pull (after the turn) are the same sync at
 *  different times — a sync is idempotent, so running it both ends is safe. */
export async function sync(chatId: string, folder: PcFolder): Promise<{ synced: number; conflicts: number }> {
  const handle = await loadHandle(folder.id);
  if (!handle) throw new Error("Folder not connected.");

  const base = bases.get(folder.id) ?? null;
  const local = await localHashed(handle, folder.id);
  const remote = await serverManifest(chatId, folder.name);
  const plan = planSync(local, remote, base);

  const localWins = plan.conflicts.filter((c) => c.winner === "local").map((c) => c.path);
  const remoteWins = plan.conflicts.filter((c) => c.winner === "remote").map((c) => c.path);

  for (const path of [...plan.upload, ...localWins]) await uploadToWorkspace(chatId, folder.name, path, await readLocalFile(handle, path));
  for (const path of [...plan.download, ...remoteWins]) await writeLocalFile(handle, path, await downloadFromWorkspace(chatId, folder.name, path));
  for (const path of plan.deleteRemote) await deleteFromWorkspace(chatId, folder.name, path);
  for (const path of plan.deleteLocal) await deleteLocalFile(handle, path);

  // Reconciled: local now matches the server for every touched path. Re-walk to
  // capture that as the new base (the common ancestor for the next sync).
  lastLocal.delete(folder.id); // force a fresh re-hash of what we just wrote
  const merged = await localHashed(handle, folder.id);
  bases.set(folder.id, merged);
  // Persist best-effort for durability; a failure just means the next reload
  // starts from an empty base (safe — see the bases note above).
  fetch(`/api/folders/${folder.id}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: merged }),
  }).catch(() => {});

  return {
    synced: plan.upload.length + plan.download.length + plan.deleteRemote.length + plan.deleteLocal.length,
    conflicts: plan.conflicts.length,
  };
}

export const push = sync;
export const pull = sync;
