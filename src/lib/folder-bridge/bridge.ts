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

import { planSync, planDirs, type Manifest } from "./plan";
import {
  walkLocal, walkLocalDirs, hashCandidates, mergeHashed, sha256Hex,
  readLocalFile, writeLocalFile, deleteLocalFile, deleteLocalDir, ensureLocalDir,
  type DirHandle, type HashedManifest,
} from "./local-fs";
import { ignoredPath, oversized, FOLDER_MAX_FILES, FOLDER_MAX_TOTAL_MB } from "./filter";

export type PcFolder = { id: string; name: string };

/** Progress during a sync — a phase plus a done/total counter the UI renders as a
 *  thin bar ("Uploading 34/210"). total is 0 while scanning (count unknown yet). */
export type SyncProgress = { phase: "scanning" | "hashing" | "uploading" | "downloading"; done: number; total: number };

/** Thrown by pickAndCreate when a folder exceeds the attach ceiling (too many files
 *  or too many bytes AFTER filtering). Carries the numbers so the UI can localize
 *  the message; identified by `name` to avoid importing the class across the dynamic
 *  import boundary. */
export class FolderTooLargeError extends Error {
  constructor(public count: number, public mb: number) {
    super("folder too large");
    this.name = "FolderTooLargeError";
  }
}

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
// Base directory set per folder, parallel to `bases` — the last-synced list of
// subdirectories. Lets a dir deleted on one side be told apart from a new dir on
// the other (see planDirs). In-memory like `bases`; a reload starts empty.
const baseDirs = new Map<string, string[]>();
const lastLocal = new Map<string, HashedManifest>();

// ── File API (workspace side, /workspace/<name>/…) ───────────────────────────

async function serverTree(chatId: string, name: string): Promise<{ files: Manifest; dirs: string[] }> {
  const res = await fetch(`/api/sandbox/files?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(name)}&depth=20`);
  if (!res.ok) return { files: {}, dirs: [] };
  const { entries } = (await res.json()) as { entries?: { path: string; isDirectory: boolean; size: number; modifiedAt: string | null }[] };
  const files: Manifest = {};
  const dirs: string[] = [];
  for (const e of entries ?? []) {
    // Entries may come back relative to the queried dir or to the workspace root;
    // normalize to a path relative to the folder.
    const rel = e.path.startsWith(`${name}/`) ? e.path.slice(name.length + 1) : e.path;
    if (ignoredPath(rel)) continue; // same skip-list as the local side (symmetry)
    if (e.isDirectory) dirs.push(rel);
    else if (!oversized(e.size)) files[rel] = { mtime: e.modifiedAt ? Date.parse(e.modifiedAt) : 0, size: e.size };
  }
  return { files, dirs };
}

// Upload many files in batches to the folder-sync endpoint (one request per
// chunk, rate-limited per request) — NOT the interactive per-file upload route,
// which caps at ~10/min and would 429 on any real folder.
const UPLOAD_CHUNK = 100;
async function uploadBatch(chatId: string, name: string, paths: string[], read: (rel: string) => Promise<Blob>, onProgress?: (p: SyncProgress) => void): Promise<void> {
  for (let i = 0; i < paths.length; i += UPLOAD_CHUNK) {
    const chunk = paths.slice(i, i + UPLOAD_CHUNK);
    const form = new FormData();
    form.append("chatId", chatId);
    form.append("name", name);
    for (const rel of chunk) form.append("files", new File([await read(rel)], rel));
    const res = await fetch("/api/folders/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error("upload failed");
    onProgress?.({ phase: "uploading", done: Math.min(i + chunk.length, paths.length), total: paths.length });
  }
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

async function localHashed(handle: DirHandle, folderId: string, onProgress?: (p: SyncProgress) => void): Promise<{ hashed: HashedManifest; skipped: number }> {
  const { files: stats, skipped } = await walkLocal(handle);
  const prev = lastLocal.get(folderId) ?? {};
  const fresh: Record<string, string> = {};
  const cand = hashCandidates(stats, prev);
  let i = 0;
  for (const path of cand) {
    onProgress?.({ phase: "hashing", done: i++, total: cand.length });
    fresh[path] = await sha256Hex(await readLocalFile(handle, path));
  }
  const merged = mergeHashed(stats, prev, fresh);
  lastLocal.set(folderId, merged);
  return { hashed: merged, skipped };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Open the directory picker, create the folder row, persist the handle, and run a
 *  first sync. Returns the created folder, or null if the user dismissed the picker.
 *  `ensureChat` (a fresh chat has no DB row yet) runs AFTER the picker so the
 *  showDirectoryPicker call stays inside the user gesture, but BEFORE the POST so
 *  the row the folder references exists. */
export async function pickAndCreate(chatId: string, opts?: { name?: string; ensureChat?: () => Promise<void> }): Promise<PcFolder | null> {
  let handle: DirHandle;
  try {
    handle = await window.showDirectoryPicker!({ mode: "readwrite" });
  } catch {
    return null; // user cancelled the picker
  }
  // Refuse an oversized folder up front (after filtering out node_modules/models/etc)
  // rather than grinding through a hopeless first sync — the ceiling protects the
  // sandbox quota and the user's patience. Checked here, at the user gesture, so the
  // failure is immediate and explains itself.
  const scan = await walkLocal(handle);
  const count = Object.keys(scan.files).length;
  const bytes = Object.values(scan.files).reduce((sum, f) => sum + f.size, 0);
  if (count > FOLDER_MAX_FILES || bytes > FOLDER_MAX_TOTAL_MB * 1024 * 1024) {
    throw new FolderTooLargeError(count, Math.round(bytes / (1024 * 1024)));
  }

  await opts?.ensureChat?.();
  // Mirror the server's name sanitization so we can detect an existing row.
  const name = (opts?.name || handle.name).replace(/[^a-z0-9-_]/gi, "").toLowerCase().slice(0, 40) || "folder";

  // Folders attach to the SANDBOX (shared by a project's chats), so the same
  // folder may already be attached from a sibling chat. Re-picking it should
  // re-link the handle locally + sync, not fail — so adopt an existing row.
  const listed = await fetch(`/api/folders?chatId=${encodeURIComponent(chatId)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const match = (listed?.folders as PcFolder[] | undefined)?.find?.((f) => (f as { kind?: string }).kind !== "host" && f.name === name);
  if (match) {
    await saveHandle(match.id, handle);
    await sync(chatId, match);
    return match;
  }

  const res = await fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, name }),
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

/** The last-synced manifest for a folder (its files' paths → mtime/size/hash),
 *  or null before the first sync. Drives the file browser's per-file sync badges:
 *  a workspace file present here (and matching size) is in sync with the PC copy. */
export function syncedManifest(folderId: string): Manifest | null {
  return bases.get(folderId) ?? null;
}

/** Forget a folder's handle locally (called when the row is deleted). */
export async function forget(folderId: string): Promise<void> {
  bases.delete(folderId);
  baseDirs.delete(folderId);
  lastLocal.delete(folderId);
  await dropHandle(folderId).catch(() => {});
}

/** Full bidirectional reconcile between the local folder and /workspace/<name>.
 *  push (before a message) and pull (after the turn) are the same sync at
 *  different times — a sync is idempotent, so running it both ends is safe. */
export async function sync(chatId: string, folder: PcFolder, onProgress?: (p: SyncProgress) => void): Promise<{ synced: number; conflicts: number; skipped: number }> {
  const handle = await loadHandle(folder.id);
  if (!handle) throw new Error("Folder not connected.");

  const base = bases.get(folder.id) ?? null;
  const dbase = baseDirs.get(folder.id) ?? null;
  onProgress?.({ phase: "scanning", done: 0, total: 0 });
  const { hashed: local, skipped } = await localHashed(handle, folder.id, onProgress);
  const localDirs = await walkLocalDirs(handle);
  const { files: remote, dirs: remoteDirs } = await serverTree(chatId, folder.name);
  const plan = planSync(local, remote, base);
  const dirPlan = planDirs(localDirs, remoteDirs, dbase);

  const localWins = plan.conflicts.filter((c) => c.winner === "local").map((c) => c.path);
  const remoteWins = plan.conflicts.filter((c) => c.winner === "remote").map((c) => c.path);

  await uploadBatch(chatId, folder.name, [...plan.upload, ...localWins], (rel) => readLocalFile(handle, rel), onProgress);
  const downloads = [...plan.download, ...remoteWins];
  let di = 0;
  for (const path of downloads) {
    onProgress?.({ phase: "downloading", done: di++, total: downloads.length });
    await writeLocalFile(handle, path, await downloadFromWorkspace(chatId, folder.name, path));
  }
  for (const path of plan.deleteRemote) await deleteFromWorkspace(chatId, folder.name, path);
  for (const path of plan.deleteLocal) await deleteLocalFile(handle, path);
  // Directory sync (3-way, so a folder deleted on the PC is removed on the server
  // instead of being blindly re-mirrored back down). Delete husks first, then
  // create genuinely-new server dirs — mirrors empty folders the agent made.
  for (const d of dirPlan.deleteRemote) await deleteFromWorkspace(chatId, folder.name, d);
  for (const d of dirPlan.deleteLocal) await deleteLocalDir(handle, d);
  for (const d of dirPlan.createLocal) await ensureLocalDir(handle, d).catch(() => {});

  // Reconciled: local now matches the server for every touched path. Re-walk to
  // capture that as the new base (the common ancestor for the next sync).
  lastLocal.delete(folder.id); // force a fresh re-hash of what we just wrote
  const { hashed: merged } = await localHashed(handle, folder.id);
  bases.set(folder.id, merged);
  baseDirs.set(folder.id, await walkLocalDirs(handle));
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
    skipped,
  };
}

export const push = sync;
export const pull = sync;
