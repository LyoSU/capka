import { normalize } from "node:path";

/**
 * Lexical validation for host folder bind-mount sources. The controller runs in a
 * container and cannot realpath arbitrary HOST paths (a host-level symlink
 * `/srv/share -> /etc` is undetectable from in here), so this is deliberately a
 * lexical denylist + optional allowlist gate — the human confirm in chat and the
 * `SANDBOX_MOUNT_ALLOW` perimeter are the real trust boundary. Pure + unit-tested.
 */

// System trees that must never be exposed to a sandbox, no matter what the
// admin confirms in chat. Boundary-checked: /etc and /etc/ssl are denied,
// /etcetera is not. The DATA_ROOT family is denied in BOTH directions —
// mounting a child leaks other users' workspaces, mounting an ancestor leaks
// the whole store.
// `/lib64`, `/lib32` and `/libx32` are SIBLINGS of /lib, not children — no containment
// check reaches them, so they need their own entries. (`/lib64`.startsWith("/lib/") is
// false.) On a merged-/usr host they are symlinks into /usr, but the controller cannot
// resolve host symlinks from inside its container, so the lexical entry is what holds.
const DENY = ["/", "/etc", "/proc", "/sys", "/dev", "/run", "/var/run",
  "/var/lib/docker", "/boot", "/root", "/usr", "/bin", "/sbin",
  "/lib", "/lib64", "/lib32", "/libx32"];

// Normalize a path and strip a trailing slash so containment checks compare
// like with like. Without this, a root written with a trailing slash
// (`/srv/share/`, a very common way to name a directory) normalizes to
// `/srv/share/` while the candidate is stripped to `/srv/share/reports`, and
// the boundary check below never matches — every mount under an allowlisted
// root gets wrongly rejected.
const clean = (p) => {
  const n = normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
};

const isUnder = (p, root) =>
  root === "/" ? true : p === root || p.startsWith(root + "/");

export function validateMountPath(hostPath, { dataRoot, hostDataRoot, allowRoots = [] }) {
  if (typeof hostPath !== "string" || hostPath.includes("\0") || !hostPath.startsWith("/")) {
    return { ok: false, code: "not_absolute" };
  }
  const p = clean(hostPath);
  if (p.includes("..")) return { ok: false, code: "denied" };
  // "/" denies only the exact filesystem root; every other entry denies the
  // path itself, anything under it, and anything that CONTAINS it. (isUnder treats
  // "/" as "contains all", which is what we want for the allowlist below but not here.)
  //
  // Both directions, exactly like the dataRoot check below — this used to test
  // descendants only, so `/var/run/docker.sock` was denied while its parent `/var` was
  // not, and mounting `/var` handed the sandbox the Docker socket anyway. Note that this
  // is deliberately NOT the same as adding "/var" to the list: `/var` is refused because
  // it CONTAINS a denied tree, while `/var/www` contains none and stays mountable for an
  // admin who confirms it. A blanket "/var" entry would take that away.
  if (p === "/" || DENY.some((d) => d !== "/" && (isUnder(p, clean(d)) || isUnder(clean(d), p)))) {
    return { ok: false, code: "denied" };
  }
  for (const dr of [dataRoot, hostDataRoot].filter(Boolean)) {
    // contains, is, or is contained by the data root — all leak workspaces
    const c = clean(dr);
    if (isUnder(p, c) || isUnder(c, p)) return { ok: false, code: "denied" };
  }
  if (allowRoots.length && !allowRoots.some((r) => isUnder(p, clean(r)))) {
    return { ok: false, code: "outside_allowlist" };
  }
  return { ok: true, path: p };
}
