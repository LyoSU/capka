import { resolve } from "node:path";
import { realpath } from "node:fs/promises";

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

/** Like safeJoin, but also resolves symlinks and re-checks containment, so a
 *  symlink planted inside the workspace can't point the operation outside it.
 *  A not-yet-existing path (write target) is returned as the safe-joined path. */
export async function safeRealPath(base, userPath) {
  const full = safeJoin(base, userPath);
  try {
    const real = await realpath(full);
    if (real !== base && !real.startsWith(base + "/")) throw new Error("Symlink escape blocked");
    return real;
  } catch (e) {
    if (e.code === "ENOENT") return full; // file doesn't exist yet (write ops)
    throw e;
  }
}
