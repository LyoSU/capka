import { createReadStream, constants as FS } from "node:fs";
import { readdir, stat, lstat, mkdir, chown, rm, open } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitize, safeRealPath, assertNoSymlinkEscape } from "../path-safety.js";

const execFileP = promisify(execFile);

/** WorkspaceStore backed by the local filesystem (Stage 1 default). All file
 *  endpoints in the controller core go through this port, so swapping in an
 *  S3Store later (Stage 2) needs no core changes. */
export class LocalFsStore {
  constructor({ dataRoot, hostDataRoot, uid, gid }) {
    this.dataRoot = dataRoot;
    this.hostDataRoot = hostDataRoot || dataRoot; // see detectHostDataRoot()
    this.uid = uid;
    this.gid = gid;
  }

  #wsPath(userId, sessionId) {
    return resolve(this.dataRoot, sanitize(userId), sanitize(sessionId), "sandbox");
  }
  #sharedPath(userId) {
    return resolve(this.dataRoot, sanitize(userId), "_global", "sandbox");
  }
  /** Translate an internal storage path to the daemon-host path used for binds. */
  toHostPath(internalPath) {
    return internalPath.startsWith(this.dataRoot)
      ? this.hostDataRoot + internalPath.slice(this.dataRoot.length)
      : internalPath;
  }

  async ensure(userId, sessionId) {
    const wsPath = this.#wsPath(userId, sessionId);
    const sharedPath = this.#sharedPath(userId);
    await mkdir(wsPath, { recursive: true });
    await mkdir(sharedPath, { recursive: true });
    for (const dir of [wsPath, sharedPath]) {
      await chown(dir, this.uid, this.gid).catch((e) =>
        console.warn(`[mounts] chown ${dir} failed: ${e.message}`));
    }
    return { wsHostPath: this.toHostPath(wsPath), sharedHostPath: this.toHostPath(sharedPath) };
  }

  /** List a workspace directory. `depth` 1 (default) = a single level — the file
   *  browser's behavior, unchanged. depth > 1 walks subdirectories (parent before
   *  children, full relative `path` on each) so a container-free workspace snapshot
   *  can mirror the old `find -maxdepth N`. `limit` hard-caps the entry count so a
   *  huge tree can't blow up the response. */
  async list(userId, sessionId, relPath = ".", depth = 1, limit = 1000) {
    const base = this.#wsPath(userId, sessionId);
    const entries = [];
    const walk = async (rel, d) => {
      if (entries.length >= limit) return;
      const dirPath = await safeRealPath(base, rel);
      const names = await readdir(dirPath).catch(() => []);
      for (const name of names) {
        if (entries.length >= limit) break;
        try {
          const s = await stat(join(dirPath, name));
          const childRel = rel === "." ? name : `${rel}/${name}`;
          const isDirectory = s.isDirectory();
          entries.push({ name, path: childRel, isDirectory, size: s.size, modifiedAt: s.mtime.toISOString() });
          if (isDirectory && d > 1) await walk(childRel, d - 1);
        } catch { /* skip inaccessible */ }
      }
    };
    await walk(relPath, Math.max(1, depth));
    return entries;
  }

  async read(userId, sessionId, relPath) {
    const base = this.#wsPath(userId, sessionId);
    const full = await safeRealPath(base, relPath);
    const s = await stat(full).catch(() => null);
    if (!s || s.isDirectory()) throw Object.assign(new Error("File not found"), { code: "ENOENT" });
    return createReadStream(full);
  }

  async write(userId, sessionId, relPath, data) {
    const base = this.#wsPath(userId, sessionId);
    const full = await safeRealPath(base, relPath);
    await mkdir(dirname(full), { recursive: true }).catch(() => {});
    // Re-validate the ancestor chain right before opening: an intermediate dir could
    // have been swapped for a symlink since safeRealPath ran (TOCTOU). O_NOFOLLOW
    // then covers the leaf; together they make the open race-free.
    await assertNoSymlinkEscape(base, full);
    const fh = await open(full, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
    try {
      await fh.writeFile(data);
      await fh.chown(this.uid, this.gid).catch(() => {});
    } finally {
      await fh.close();
    }
  }

  async size(userId, sessionId) {
    const dir = this.#wsPath(userId, sessionId);
    // `du` (C, warm inode cache) is dramatically cheaper than recursing the tree
    // with readdir+stat in JS — a bloated workspace can hold tens of thousands of
    // files, and this runs on the exec quota gate AND the periodic sweep, so a JS
    // walk meant ~N stat syscalls per call. `-sk` reports KB blocks (disk usage);
    // ×1024 → bytes. Fall back to the JS walk only if `du` can't run, so the quota
    // gate never silently reads 0 and lets a full workspace through.
    try {
      const { stdout } = await execFileP("du", ["-sk", dir]);
      const kb = parseInt(stdout, 10);
      if (Number.isFinite(kb)) return kb * 1024;
    } catch { /* du missing/failed (or dir absent) → fall through */ }
    const dirSize = async (d) => {
      let total = 0;
      try {
        for (const entry of await readdir(d, { withFileTypes: true })) {
          const full = join(d, entry.name);
          total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
        }
      } catch { /* missing */ }
      return total;
    };
    return dirSize(dir);
  }

  // Dependency/bytecode/build-cache dirs the agent regenerates on demand (pip/npm
  // install, recompile). Deleting these frees space without losing the user's own
  // files. Deliberately NOT including `.git` (version history isn't regenerable) or
  // generic output dirs like `dist`/`build` (could be the user's deliverable).
  static #REGENERABLE = new Set([
    "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", "site-packages", ".ipynb_checkpoints",
  ]);

  /** Remove regenerable dep/cache dirs anywhere in the workspace tree. Walks with
   *  `withFileTypes` + skips symlinks entirely, so it can only ever `rm` a real
   *  directory reached through real directories — a sandbox-planted symlink named
   *  `node_modules` pointing outside is never followed or deleted through. */
  async pruneRegenerable(userId, sessionId) {
    const walk = async (dir) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink() || !e.isDirectory()) continue; // never cross a symlink
        const full = join(dir, e.name);
        if (LocalFsStore.#REGENERABLE.has(e.name)) {
          await rm(full, { recursive: true, force: true }).catch(() => {});
        } else {
          await walk(full);
        }
      }
    };
    await walk(this.#wsPath(userId, sessionId));
  }

  async remove(userId, sessionId) {
    await rm(this.#wsPath(userId, sessionId), { recursive: true, force: true });
  }

  /** Delete a workspace path — a file, or a directory and its whole subtree.
   *  safeRealPath guarantees the target stays inside the workspace (a planted
   *  symlink either resolves in-bounds or throws), so the rm can never escape.
   *  Missing path is a no-op (idempotent — a detach racing a prior delete must
   *  not error). Directories ARE removed recursively: it's the only way to free a
   *  workspace stuffed with folders (e.g. a Python venv), and the one escape from
   *  the disk-quota gate, which blocks the in-sandbox `rm`. The blast radius is
   *  bounded to whatever path the (already-authorized) caller names. */
  async delete(userId, sessionId, relPath) {
    const base = this.#wsPath(userId, sessionId);
    const full = await safeRealPath(base, relPath);
    // rm has no O_NOFOLLOW equivalent, so re-walk the ancestor chain right before
    // removing: a symlink swapped into an intermediate component since safeRealPath
    // ran (TOCTOU) must not let the rm escape the workspace.
    await assertNoSymlinkEscape(base, full);
    const s = await lstat(full).catch(() => null);
    if (!s) return;
    // A symlink leaf: remove the link itself, never recurse through it.
    await rm(full, { recursive: s.isDirectory() && !s.isSymbolicLink(), force: true });
  }
}

/** Resolve the daemon-host path backing dataRoot by inspecting our own container.
 *  An explicit override wins. Returns the host path string.
 *
 *  `failClosed` (set when the daemon is remote, i.e. DOCKER_HOST is configured):
 *  if resolution fails we THROW instead of silently returning the internal
 *  dataRoot. On a remote daemon a wrong value produces sandbox bind mounts that
 *  point at a non-existent host path — mounts that "succeed" but back an empty or
 *  wrong directory. Better to refuse to boot than to mount garbage. For a local
 *  daemon (failClosed off) the container and host share a filesystem, so dataRoot
 *  is itself the correct host path and the fallback is sound. */
export async function detectHostDataRoot(docker, { dataRoot, hostname, override, failClosed = false }) {
  if (override) return override;
  let reason;
  try {
    const self = await docker.getContainer(hostname).inspect();
    const backing = (self.Mounts || [])
      .filter((m) => m.Destination === dataRoot || dataRoot.startsWith(m.Destination + "/"))
      .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (backing) return backing.Source + dataRoot.slice(backing.Destination.length);
    reason = `no mount backs ${dataRoot}`;
  } catch (e) {
    reason = `self-inspect failed (${e.message})`;
  }
  if (failClosed) {
    throw new Error(
      `FATAL: could not resolve the daemon-host path for ${dataRoot}: ${reason}.\n` +
      `  The daemon is remote (DOCKER_HOST set), so sandbox bind mounts need the real\n` +
      `  host path. Set HOST_DATA_ROOT explicitly to override.`,
    );
  }
  console.warn(`[host-path] ${reason}; using ${dataRoot} (local daemon)`);
  return dataRoot;
}
