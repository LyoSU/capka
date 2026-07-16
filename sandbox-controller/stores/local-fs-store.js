import { createReadStream, constants as FS } from "node:fs";
import { readdir, stat, lstat, mkdir, chown, rm, open, cp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { sanitize, safeRealPath, assertNoSymlinkEscape } from "../path-safety.js";

const execFileP = promisify(execFile);

/** SHA-256 (hex) of a file's contents, streamed so a large file isn't buffered
 *  whole. Used only by the folder-sync listing (withHash), so the client can
 *  compare content by hash instead of size — a same-length edit must still count
 *  as a change or it silently never syncs. */
async function hashFile(full) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(full);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

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

  // Content-hash cache for the folder-sync listing, keyed by the file identity and
  // nanosecond change-time/mtime. Folder sync lists (and hashes) the whole tree twice per turn; without
  // this, every unchanged file is re-read and SHA-256'd each time — material I/O on
  // a large folder. `ctimeNs` is essential: an editor (or hostile sandbox process)
  // can replace same-length content and restore the old mtime, but cannot restore
  // the kernel-managed change time. Stale keys age out by FIFO once the cap is hit.
  #hashCache = new Map();
  #HASH_CACHE_MAX = 50000;

  async #hashFileCached(full, s) {
    const key = `${full}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    const cached = this.#hashCache.get(key);
    if (cached !== undefined) return cached;
    const hash = await hashFile(full).catch(() => undefined);
    if (hash !== undefined) {
      if (this.#hashCache.size >= this.#HASH_CACHE_MAX) {
        this.#hashCache.delete(this.#hashCache.keys().next().value); // evict oldest
      }
      this.#hashCache.set(key, hash);
    }
    return hash;
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
   *  huge tree can't blow up the response.
   *
   *  Returns `{ entries, truncated }`. `truncated` is true when the listing is
   *  INCOMPLETE — either the entry limit was hit, OR a multi-level walk bottomed
   *  out on a directory that still had children (the depth cap, which also guards
   *  against symlink-cycle recursion). Folder sync MUST refuse a truncated tree:
   *  treating the unseen files as absent would drive a destructive local delete.
   *  With `withHash`, each file entry also carries a content SHA-256 (`hash`). */
  async list(userId, sessionId, relPath = ".", depth = 1, limit = 1000, { withHash = false } = {}) {
    const base = this.#wsPath(userId, sessionId);
    const deep = depth > 1; // multi-level walk → a dir left un-descended means incomplete
    const entries = [];
    let truncated = false;
    const walk = async (rel, d) => {
      if (entries.length >= limit) { truncated = true; return; }
      const dirPath = await safeRealPath(base, rel);
      const names = await readdir(dirPath).catch(() => []);
      for (const name of names) {
        if (entries.length >= limit) { truncated = true; break; }
        try {
          const childRel = rel === "." ? name : `${rel}/${name}`;
          // Resolve and contain EACH child before reading metadata or hashing it.
          // A sandbox can plant a symlink in a directory after the parent was
          // validated; stat/hash on join(dirPath, name) would otherwise follow an
          // out-of-workspace target before the recursive walk gets a safety check.
          const full = await safeRealPath(base, childRel);
          const s = await stat(full, { bigint: true });
          const isDirectory = s.isDirectory();
          const entry = { name, path: childRel, isDirectory, size: Number(s.size), modifiedAt: s.mtime.toISOString() };
          if (!isDirectory && withHash) entry.hash = await this.#hashFileCached(full, s);
          entries.push(entry);
          if (isDirectory) {
            if (d > 1) await walk(childRel, d - 1);
            else if (deep) {
              // Hit the depth floor with more below → the tree is incomplete.
              const kids = await readdir(full).catch(() => []);
              if (kids.length) truncated = true;
            }
          }
        } catch { /* skip inaccessible */ }
      }
    };
    await walk(relPath, Math.max(1, depth));
    return { entries, truncated };
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

  /** Stream the WHOLE workspace as a gzipped tar, read straight from the host
   *  directory — no container, and no dependence on a client-visible listing (the
   *  file-browser's `download-all` archives only paths the client enumerated, so a
   *  truncated listing silently drops files; this is the honest "download before
   *  delete" backup). Packs the directory contents at the archive root (`.`).
   *  Returns the spawned `tar` process; the caller pipes `.stdout` and watches for
   *  a non-zero exit. Ensures the dir first so an empty workspace still tars. */
  async archive(userId, sessionId) {
    const dir = this.#wsPath(userId, sessionId);
    await mkdir(dir, { recursive: true });
    return spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Copy the entire contents of one workspace into another (same user) under a
   *  named subdir — the chat→project file carry-over on a move. Idempotent by
   *  destination: any prior copy at `subdir` is removed first, so a retry after a
   *  failed move leaves ONE folder, not a pile. Quota-gates the TARGET (measured
   *  after clearing the old copy, so the retry doesn't double-count) and throws a
   *  WORKSPACE_FULL-tagged error if the incoming bytes wouldn't fit. `safeRealPath`
   *  keeps `subdir` inside the destination workspace. */
  async copyInto(userId, srcSessionId, destSessionId, subdir, { limitBytes } = {}) {
    const src = this.#wsPath(userId, srcSessionId);
    const destBase = this.#wsPath(userId, destSessionId);
    await mkdir(destBase, { recursive: true });
    const destDir = await safeRealPath(destBase, subdir);
    await assertNoSymlinkEscape(destBase, destDir);
    await rm(destDir, { recursive: true, force: true }); // idempotent replace

    if (limitBytes != null) {
      const [destBytes, srcBytes] = await Promise.all([
        this.size(userId, destSessionId), // subdir already removed above
        this.size(userId, srcSessionId),
      ]);
      if (destBytes + srcBytes > limitBytes) {
        throw Object.assign(new Error("Workspace is full"), { code: "WORKSPACE_FULL" });
      }
    }

    await mkdir(destDir, { recursive: true });
    // fs.cp copies the whole tree (dotfiles included) with a CONSTANT argv, so a
    // workspace with thousands of files can't blow the exec arg limit (E2BIG) the
    // way a per-entry `cp` argv would. A missing/empty source is a no-op.
    await cp(src, destDir, { recursive: true, force: true }).catch((e) => {
      if (e?.code !== "ENOENT") throw e;
    });
    await execFileP("chown", ["-R", `${this.uid}:${this.gid}`, destDir]).catch(() => {});
    return { subdir };
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
