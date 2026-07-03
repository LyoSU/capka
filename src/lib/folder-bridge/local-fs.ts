/**
 * Local filesystem access for PC folders, via the browser File System Access API.
 * Split into a PURE part (the hash prefilter — unit-tested) and thin handle I/O
 * (untestable in vitest, kept minimal). Handles are `FileSystemDirectoryHandle`s
 * the user granted; we model them with local interfaces so this file doesn't
 * depend on the FS-Access lib.dom typings being present.
 */

import { ignoredPath, oversized } from "./filter";

export type LocalStat = { mtime: number; size: number };
export type LocalManifest = Record<string, LocalStat>;
export type HashedManifest = Record<string, { mtime: number; size: number; hash: string }>;

/** Which paths need (re)hashing: new since last time, or with a changed mtime/size.
 *  Unchanged entries keep their cached hash — SHA-256 is expensive, this skips it
 *  for the untouched bulk of a folder. Pure. */
export function hashCandidates(current: LocalManifest, prev: HashedManifest): string[] {
  const out: string[] = [];
  for (const [path, s] of Object.entries(current)) {
    const p = prev[path];
    if (!p || p.mtime !== s.mtime || p.size !== s.size) out.push(path);
  }
  return out.sort();
}

/** Fold freshly-computed hashes together with the still-valid cached ones into a
 *  full hashed manifest for `current`. Pure. */
export function mergeHashed(current: LocalManifest, prev: HashedManifest, fresh: Record<string, string>): HashedManifest {
  const out: HashedManifest = {};
  for (const [path, s] of Object.entries(current)) {
    const hash = fresh[path] ?? prev[path]?.hash;
    if (hash != null) out[path] = { mtime: s.mtime, size: s.size, hash };
  }
  return out;
}

// ── Handle I/O (browser only) ────────────────────────────────

export interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BufferSource | Blob | string): Promise<void>; close(): Promise<void> }>;
}
export interface DirHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/** Recursively list a directory handle into a mtime+size manifest (no hashing).
 *  Skips ignored trees (never even descends node_modules/.git/etc — the big perf
 *  win) and files over the size cap; `skipped` counts oversized files, so the UI
 *  can tell the user why a large file didn't make it into the sandbox. */
export async function walkLocal(dir: DirHandle, prefix = ""): Promise<{ files: LocalManifest; skipped: number }> {
  const files: LocalManifest = {};
  let skipped = 0;
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (ignoredPath(path)) continue; // never descend/collect ignored dirs & junk files
    if (handle.kind === "directory") {
      const sub = await walkLocal(handle, path);
      Object.assign(files, sub.files);
      skipped += sub.skipped;
    } else {
      const f = await handle.getFile();
      if (oversized(f.size)) { skipped++; continue; }
      files[path] = { mtime: f.lastModified, size: f.size };
    }
  }
  return { files, skipped };
}

/** Recursively list a directory handle's SUBDIRECTORIES (paths, no files) — the dir
 *  counterpart to walkLocal. Feeds the directory 3-way merge so a folder the user
 *  deletes on the PC is detected and removed on the server, not silently re-mirrored. */
export async function walkLocalDirs(dir: DirHandle, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "directory") continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (ignoredPath(path)) continue; // don't list or descend ignored trees
    out.push(path);
    out.push(...await walkLocalDirs(handle, path));
  }
  return out;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolve nested "a/b/c" under a directory handle. `create` makes missing dirs. */
async function resolveDir(root: DirHandle, parts: string[], create: boolean): Promise<DirHandle> {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

/** Create a (possibly nested) directory locally if missing — so empty folders the
 *  agent made on the server still appear on the user's computer (file-based sync
 *  otherwise skips a directory with no files in it). */
export async function ensureLocalDir(root: DirHandle, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  if (parts.length) await resolveDir(root, parts, true);
}

export async function readLocalFile(root: DirHandle, path: string): Promise<File> {
  const parts = path.split("/");
  const dir = await resolveDir(root, parts.slice(0, -1), false);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

export async function writeLocalFile(root: DirHandle, path: string, data: Blob): Promise<void> {
  const parts = path.split("/");
  const dir = await resolveDir(root, parts.slice(0, -1), true);
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function deleteLocalFile(root: DirHandle, path: string): Promise<void> {
  const parts = path.split("/");
  const dir = await resolveDir(root, parts.slice(0, -1), false).catch(() => null);
  if (dir) await dir.removeEntry(parts[parts.length - 1]).catch(() => {});
}

/** Remove a (possibly non-empty) directory locally — mirrors a server-side dir
 *  delete onto the PC. Recursive so a subtree removed on the server clears fully. */
export async function deleteLocalDir(root: DirHandle, path: string): Promise<void> {
  const parts = path.split("/");
  const dir = await resolveDir(root, parts.slice(0, -1), false).catch(() => null);
  if (dir) await dir.removeEntry(parts[parts.length - 1], { recursive: true }).catch(() => {});
}
