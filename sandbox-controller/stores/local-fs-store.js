import { createReadStream, constants as FS } from "node:fs";
import { readdir, stat, mkdir, chown, rm, open } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { sanitize, safeRealPath } from "../path-safety.js";

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

  async list(userId, sessionId, relPath = ".") {
    const base = this.#wsPath(userId, sessionId);
    const dirPath = await safeRealPath(base, relPath);
    const names = await readdir(dirPath).catch(() => []);
    const entries = [];
    for (const name of names) {
      try {
        const s = await stat(join(dirPath, name));
        entries.push({
          name,
          path: relPath === "." ? name : `${relPath}/${name}`,
          isDirectory: s.isDirectory(),
          size: s.size,
          modifiedAt: s.mtime.toISOString(),
        });
      } catch { /* skip inaccessible */ }
    }
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
    // O_NOFOLLOW closes the residual TOCTOU window: even if a symlink is planted
    // at the leaf between safeRealPath() and open(), the write refuses to follow
    // it (ELOOP). Overwriting an existing *regular* file still works.
    const fh = await open(full, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
    try {
      await fh.writeFile(data);
      await fh.chown(this.uid, this.gid).catch(() => {});
    } finally {
      await fh.close();
    }
  }

  async size(userId, sessionId) {
    const dirSize = async (dir) => {
      let total = 0;
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
        }
      } catch { /* missing */ }
      return total;
    };
    return dirSize(this.#wsPath(userId, sessionId));
  }

  async remove(userId, sessionId) {
    await rm(this.#wsPath(userId, sessionId), { recursive: true, force: true });
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
