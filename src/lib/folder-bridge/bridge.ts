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
import { ignoredPath, oversized, exceedsCeiling, sanitizeFolderName, FolderTooLargeError } from "./filter";
import { type WorkspaceTarget, targetQuery } from "@/lib/workspace-target";

/** The chatId / projectId body fields that address a target on the folders API. */
function targetBody(target: WorkspaceTarget): Record<string, string> {
  return target.kind === "chat" ? { chatId: target.chatId } : { projectId: target.projectId };
}

export type PcFolder = { id: string; name: string };

/** Progress during a sync — a phase plus a done/total counter the UI renders as a
 *  thin bar ("Uploading 34/210"). total is 0 while scanning (count unknown yet). */
export type SyncProgress = { phase: "scanning" | "hashing" | "uploading" | "downloading"; done: number; total: number };

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

// The 3-way merge ancestor is NOT trusted from tab memory — it's loaded fresh
// from the shared server row at the start of every sync (loadState) and written
// back with an optimistic revision (CAS), so two tabs (or two project members)
// syncing the same folder can't clobber each other's ancestor and resurrect a
// deleted file. `bases` here is only a *badge cache* for the file browser (the
// last manifest THIS tab synced); it never feeds the merge.
const bases = new Map<string, Manifest>();
// Per-folder hash cache for the local prefilter (skip re-hashing unchanged files).
const lastLocal = new Map<string, HashedManifest>();

// ── File API (workspace side, /workspace/<name>/…) ───────────────────────────

// Ask for a tree far larger than the attach ceiling (FOLDER_MAX_FILES) so a
// legitimately-capped folder is always listed WHOLE; the server clamps this and
// flags `truncated` if even this isn't enough, which aborts the sync (see below).
const SYNC_LIST_LIMIT = 15000;

async function serverTree(target: WorkspaceTarget, name: string): Promise<{ files: Manifest; dirs: string[]; excluded: string[] }> {
  // hash=1 makes each file carry a content SHA-256 so plan.ts compares by content,
  // not by size — a same-length edit on the server must still count as a change.
  const res = await fetch(`/api/sandbox/files?${targetQuery(target)}&path=${encodeURIComponent(name)}&depth=20&limit=${SYNC_LIST_LIMIT}&hash=1`);
  // A non-OK response must NOT look like "the server is empty" — that would drive a
  // destructive local delete of every synced file on a transient 403/500. Abort the
  // sync instead (base is left untouched, so the next sync retries cleanly).
  if (!res.ok) throw new Error(`Could not read the workspace (HTTP ${res.status}).`);
  const { entries, truncated } = (await res.json()) as {
    entries?: { path: string; isDirectory: boolean; size: number; modifiedAt: string | null; hash?: string }[];
    truncated?: boolean;
  };
  // A truncated tree is an INCOMPLETE server view (entry cap OR a subtree past the
  // depth limit); treating the unseen files as deletions would wipe them locally.
  // Refuse rather than sync a partial picture.
  if (truncated) throw new Error("This folder's workspace copy is too large to sync safely.");
  const files: Manifest = {};
  const dirs: string[] = [];
  const excluded: string[] = [];
  for (const e of entries ?? []) {
    // Entries may come back relative to the queried dir or to the workspace root;
    // normalize to a path relative to the folder.
    const rel = e.path.startsWith(`${name}/`) ? e.path.slice(name.length + 1) : e.path;
    if (ignoredPath(rel)) continue; // same skip-list as the local side (symmetry)
    if (e.isDirectory) dirs.push(rel);
    else if (oversized(e.size)) excluded.push(rel); // track: absence ≠ delete (see planSync)
    else files[rel] = { mtime: e.modifiedAt ? Date.parse(e.modifiedAt) : 0, size: e.size, hash: e.hash };
  }
  return { files, dirs, excluded };
}

/** Bounded-parallel map — runs `fn` over `items` with at most `limit` in flight.
 *  Folder-sync file ops (download/write) are independent per path, so a pool turns
 *  a serial round-trip-per-file wait into a handful of concurrent ones. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i]);
  }));
}

// Upload many files in batches to the folder-sync endpoint (one request per
// chunk, rate-limited per request) — NOT the interactive per-file upload route,
// which caps at ~10/min and would 429 on any real folder.
const UPLOAD_CHUNK = 100;
export async function uploadBatch(target: WorkspaceTarget, name: string, paths: string[], read: (rel: string) => Promise<Blob>, onProgress?: (p: SyncProgress) => void): Promise<void> {
  for (let i = 0; i < paths.length; i += UPLOAD_CHUNK) {
    const chunk = paths.slice(i, i + UPLOAD_CHUNK);
    const form = new FormData();
    for (const [k, v] of Object.entries(targetBody(target))) form.append(k, v);
    form.append("name", name);
    for (const rel of chunk) form.append("files", new File([await read(rel)], rel));
    const res = await fetch("/api/folders/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error("upload failed");
    onProgress?.({ phase: "uploading", done: Math.min(i + chunk.length, paths.length), total: paths.length });
  }
}

async function downloadFromWorkspace(target: WorkspaceTarget, name: string, rel: string): Promise<Blob> {
  const res = await fetch(`/api/sandbox/files/download?${targetQuery(target)}&path=${encodeURIComponent(`${name}/${rel}`)}`);
  if (!res.ok) throw new Error("download failed");
  return res.blob();
}

async function deleteFromWorkspace(target: WorkspaceTarget, name: string, rel: string): Promise<void> {
  const res = await fetch(`/api/sandbox/files?${targetQuery(target)}&path=${encodeURIComponent(`${name}/${rel}`)}`, { method: "DELETE" });
  // A swallowed delete failure would let base advance as if the file were gone,
  // so the next sync re-creates it (or reports a false "synced"). Abort instead;
  // the controller delete is idempotent, so a missing path still returns OK.
  if (!res.ok) throw new Error(`Could not delete ${rel} from the workspace (HTTP ${res.status}).`);
}

// ── Local hashing (with the prefilter) ───────────────────────────────────────

async function localHashed(handle: DirHandle, folderId: string, onProgress?: (p: SyncProgress) => void): Promise<{ hashed: HashedManifest; skipped: number; excluded: string[] }> {
  const { files: stats, skipped, excluded } = await walkLocal(handle);
  const prev = lastLocal.get(folderId) ?? {};
  const fresh: Record<string, string> = {};
  const cand = hashCandidates(stats, prev);
  // Hash candidates with a bounded pool — each file's read + SHA-256 is independent,
  // so a handful in flight turns a serial file-by-file wait into concurrent work on
  // the first sync of a large folder (later syncs re-hash only what changed). Writes
  // to `fresh`/`done` are safe: JS runs these callbacks on one thread.
  let done = 0;
  await runPool(cand, 8, async (path) => {
    const hex = await sha256Hex(await readLocalFile(handle, path));
    fresh[path] = hex;
    onProgress?.({ phase: "hashing", done: ++done, total: cand.length });
  });
  const merged = mergeHashed(stats, prev, fresh);
  lastLocal.set(folderId, merged);
  return { hashed: merged, skipped, excluded };
}

/** Load the 3-way merge ancestor + its revision from the shared server row. Read
 *  FRESH at the start of every sync (the row is the cross-tab source of truth), so
 *  a stale tab never reverts an ancestor another tab already advanced. Only accepts
 *  the versioned `{v:1,rev,files,dirs}` shape; anything else (absent, legacy,
 *  malformed) yields an empty base (rev 0) — the safe union fallback. Never throws. */
async function loadState(folderId: string): Promise<{ files: Manifest; dirs: string[]; rev: number }> {
  try {
    const res = await fetch(`/api/folders/${folderId}/state`);
    if (res.ok) {
      const { state } = (await res.json()) as { state?: { v?: number; rev?: number; files?: Manifest; dirs?: string[] } };
      if (state?.v === 1 && state.files) return { files: state.files, dirs: state.dirs ?? [], rev: state.rev ?? 0 };
    }
  } catch { /* best-effort — empty base is a safe union */ }
  return { files: {}, dirs: [], rev: 0 };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Open the directory picker, create the folder row, persist the handle, and run a
 *  first sync. Returns the created folder, or null if the user dismissed the picker.
 *  `ensureChat` (a fresh chat has no DB row yet) runs AFTER the picker so the
 *  showDirectoryPicker call stays inside the user gesture, but BEFORE the POST so
 *  the row the folder references exists. */
export async function pickAndCreate(target: WorkspaceTarget, opts?: { name?: string; ensureChat?: () => Promise<void> }): Promise<PcFolder | null> {
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
  if (exceedsCeiling(count, bytes)) throw new FolderTooLargeError(count, bytes);

  await opts?.ensureChat?.();
  // Same sanitization as the server (shared helper) so the name we compute to
  // detect an existing row stays byte-identical to what the server stored.
  const name = sanitizeFolderName(opts?.name || handle.name) || "folder";

  // Folders attach to the SANDBOX (shared by a project's chats), so the same
  // folder may already be attached from a sibling chat. Re-picking it should
  // re-link the handle locally + sync, not fail — so adopt an existing row.
  const listed = await fetch(`/api/folders?${targetQuery(target)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const match = (listed?.folders as PcFolder[] | undefined)?.find?.((f) => (f as { kind?: string }).kind !== "host" && f.name === name);
  if (match) {
    await saveHandle(match.id, handle);
    await sync(target, match);
    return match;
  }

  const res = await fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...targetBody(target), name }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Could not attach the folder.");
  const { folder } = (await res.json()) as { folder: PcFolder };
  await saveHandle(folder.id, handle);
  await sync(target, folder);
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
  lastLocal.delete(folderId);
  await dropHandle(folderId).catch(() => {});
}

/** Full bidirectional reconcile between the local folder and /workspace/<name>.
 *  push (before a message) and pull (after the turn) are the same sync at
 *  different times — a sync is idempotent, so running it both ends is safe. */
export async function sync(target: WorkspaceTarget, folder: PcFolder, onProgress?: (p: SyncProgress) => void): Promise<{ synced: number; conflicts: number; skipped: number }> {
  const handle = await loadHandle(folder.id);
  if (!handle) throw new Error("Folder not connected.");

  // Take the server-side sync lease BEFORE touching any file, so a second tab or
  // project member can't run destructive operations against this folder at the
  // same time (the state CAS only guards the manifest row, not the files). If it's
  // already held, skip quietly — the in-flight sync covers this one (sync is
  // idempotent). The lease self-expires, and we release it in `finally`.
  const leaseRes = await fetch(`/api/folders/${folder.id}/lease`, { method: "POST" }).catch(() => null);
  if (leaseRes && leaseRes.status === 409) return { synced: 0, conflicts: 0, skipped: 0 };
  const leaseToken = leaseRes && leaseRes.ok ? ((await leaseRes.json()) as { token?: string }).token ?? null : null;
  try {
    return await runSync(handle);
  } finally {
    if (leaseToken) {
      await fetch(`/api/folders/${folder.id}/lease?token=${encodeURIComponent(leaseToken)}`, { method: "DELETE" }).catch(() => {});
    }
  }

  async function runSync(handle: DirHandle): Promise<{ synced: number; conflicts: number; skipped: number }> {
  // Load the merge ancestor FRESH from the shared row (source of truth across
  // tabs/members) plus its revision for the optimistic write below. A missing/empty
  // base makes this sync a safe union (no data loss, just forgets deletes once).
  const { files: base, dirs: dbase, rev } = await loadState(folder.id);
  onProgress?.({ phase: "scanning", done: 0, total: 0 });
  const { hashed: local, skipped, excluded: localExcluded } = await localHashed(handle, folder.id, onProgress);
  const localDirs = await walkLocalDirs(handle);
  const { files: remote, dirs: remoteDirs, excluded: remoteExcluded } = await serverTree(target, folder.name);
  // Paths skipped (oversized) on either side: their absence from a manifest is a
  // "didn't look", not a delete. The planner leaves them untouched entirely.
  const excluded = new Set([...localExcluded, ...remoteExcluded]);
  const plan = planSync(local, remote, base, excluded);
  const dirPlan = planDirs(localDirs, remoteDirs, dbase);

  const localWins = plan.conflicts.filter((c) => c.winner === "local").map((c) => c.path);
  const remoteWins = plan.conflicts.filter((c) => c.winner === "remote").map((c) => c.path);

  await uploadBatch(target, folder.name, [...plan.upload, ...localWins], (rel) => readLocalFile(handle, rel), onProgress);
  const downloads = [...plan.download, ...remoteWins];
  let di = 0;
  await runPool(downloads, 6, async (path) => {
    await writeLocalFile(handle, path, await downloadFromWorkspace(target, folder.name, path));
    onProgress?.({ phase: "downloading", done: ++di, total: downloads.length });
  });
  await runPool(plan.deleteRemote, 6, (path) => deleteFromWorkspace(target, folder.name, path));
  await runPool(plan.deleteLocal, 6, (path) => deleteLocalFile(handle, path));
  // Directory sync (3-way, so a folder deleted on the PC is removed on the server
  // instead of being blindly re-mirrored back down). Delete husks first, then
  // create genuinely-new server dirs — mirrors empty folders the agent made.
  for (const d of dirPlan.deleteRemote) await deleteFromWorkspace(target, folder.name, d);
  for (const d of dirPlan.deleteLocal) await deleteLocalDir(handle, d);
  for (const d of dirPlan.createLocal) await ensureLocalDir(handle, d).catch(() => {});

  // Reconciled: local now matches the server for every touched path. Re-walk to
  // capture that as the new ancestor. The hash prefilter re-hashes only the files
  // whose mtime/size changed (the downloads we just wrote); everything else keeps
  // its cached hash — no full re-hash of the whole folder.
  const { hashed: merged } = await localHashed(handle, folder.id);
  const mergedDirs = await walkLocalDirs(handle);
  bases.set(folder.id, merged); // badge cache only (not the merge base)
  // Persist the new ancestor with an optimistic revision: if another tab/member
  // advanced the row since we loaded it (rev mismatch → 409), we DON'T overwrite —
  // their ancestor stands. No corruption either way: our file ops ran against the
  // base we loaded fresh this sync, and the next sync reloads whatever the winner
  // stored. The 409 needs no client action; a transient network failure is likewise
  // best-effort (an empty base next time is a safe union).
  const put = await fetch(`/api/folders/${folder.id}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRev: rev, state: { v: 1, rev: rev + 1, files: merged, dirs: mergedDirs } }),
  }).catch(() => null);
  if (put && !put.ok && put.status !== 409) {
    console.warn(`[folders] could not persist sync state (HTTP ${put.status})`);
  }

  return {
    synced: plan.upload.length + plan.download.length + plan.deleteRemote.length + plan.deleteLocal.length,
    conflicts: plan.conflicts.length,
    skipped,
  };
  }
}
