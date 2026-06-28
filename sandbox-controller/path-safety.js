import { resolve, dirname, basename, join, relative, sep } from "node:path";
import { realpath, lstat } from "node:fs/promises";

/**
 * Path-safety primitives for the sandbox controller. Extracted from server.js so
 * they can be unit-tested in isolation — server.js has import-time side effects
 * (it refuses to boot without CONTROLLER_SECRET and binds a port), so it can't be
 * imported into a test. These functions are the controller's last line of defence
 * against a sandboxed process (or a compromised platform request) reaching files
 * outside a user's workspace, so they must stay pure and covered.
 */

/** Strip anything that isn't a safe id char, then cap length. Prevents path
 *  traversal and Docker name injection via user/session ids. */
export function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

/** Join userPath under base, rejecting any result that escapes base. A prefix
 *  check alone is unsafe (`/data/ws-evil` starts with `/data/ws`), so we require
 *  exact-equal or a real path separator boundary. */
export function safeJoin(base, userPath) {
  const full = resolve(base, userPath);
  if (full !== base && !full.startsWith(base + "/")) throw new Error("Path traversal blocked");
  return full;
}

function contained(base, p) {
  return p === base || p.startsWith(base + "/");
}

/** Like safeJoin, but also resolves symlinks and re-checks containment, so a
 *  symlink planted inside the workspace can't point the operation outside it.
 *
 *  For a not-yet-existing target (a fresh write), we cannot realpath the leaf,
 *  so we resolve the DEEPEST EXISTING ANCESTOR and verify *it* is contained,
 *  then re-attach the not-yet-created remainder. This closes the hole where a
 *  symlinked parent directory (`ws/escape -> /etc`) would redirect a write to a
 *  leaf that doesn't exist yet — realpath-the-leaf alone returns ENOENT and the
 *  write follows the symlink out of the workspace. Non-existent remainder is
 *  safe because `mkdir -p` creates those as real directories under the (already
 *  verified) real ancestor. */
export async function safeRealPath(base, userPath) {
  safeJoin(base, userPath); // lexical guard — throws on ../ or absolute escape
  // Canonicalize base so a symlinked base (e.g. macOS /var -> /private/var, or a
  // symlinked DATA_ROOT) doesn't trip the containment check on every path. If base
  // itself doesn't exist yet, nothing under it can either, so there is no symlink
  // to follow — the lexical safeJoin result is already safe.
  let realBase;
  try {
    realBase = await realpath(base);
  } catch (e) {
    if (e.code === "ENOENT") return safeJoin(base, userPath);
    throw e;
  }
  const rel = relative(base, resolve(base, userPath));

  // Walk up from the requested path to the first component that exists, resolve
  // its real path, and require it to stay inside realBase.
  let existing = rel ? join(realBase, rel) : realBase;
  const trailing = [];
  for (;;) {
    let real;
    try {
      real = await realpath(existing);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = dirname(existing);
      if (parent === existing) throw new Error("Path traversal blocked"); // hit fs root
      trailing.unshift(basename(existing));
      existing = parent;
      continue;
    }
    if (!contained(realBase, real)) throw new Error("Symlink escape blocked");
    return trailing.length ? join(real, ...trailing) : real;
  }
}

/** Final, race-free containment check, run IMMEDIATELY before the open()/rm() that
 *  acts on the path. safeRealPath canonicalizes the deepest *existing* ancestor at
 *  call time, but an attacker inside the sandbox can swap an intermediate directory
 *  for a symlink in the window between that check and the syscall (TOCTOU); O_NOFOLLOW
 *  guards only the leaf, and rm has no such flag at all. So we re-walk every path
 *  component from the workspace root down to the leaf's PARENT and lstat each one,
 *  refusing if any is a symlink — a planted intermediate link can no longer redirect
 *  the operation out of the workspace. The leaf itself is intentionally not lstat'd:
 *  write protects it with O_NOFOLLOW, and rm removes a symlink leaf (the link, not
 *  its target) harmlessly. `base` must already be a real (canonical) path. */
export async function assertNoSymlinkEscape(base, full) {
  const realBase = await realpath(base).catch(() => base);
  const rel = relative(realBase, full);
  if (rel === "" || rel === ".") return; // base itself
  if (rel.startsWith("..") || resolve(realBase, rel) !== full) throw new Error("Path traversal blocked");
  const parts = rel.split(sep).filter(Boolean);
  let cur = realBase;
  // Stop before the leaf: walk only the ancestor directories.
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]);
    const st = await lstat(cur).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
    if (!st) continue; // not yet created (mkdir -p will make a real dir under the verified base)
    if (st.isSymbolicLink()) throw new Error("Symlink escape blocked");
  }
}
