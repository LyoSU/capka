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
const DENY = ["/", "/etc", "/proc", "/sys", "/dev", "/run", "/var/run",
  "/var/lib/docker", "/boot", "/root", "/usr", "/bin", "/sbin", "/lib"];

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
  // path itself and anything under it. (isUnder treats "/" as "contains all",
  // which is what we want for the allowlist below but not here.)
  if (p === "/" || DENY.some((d) => d !== "/" && isUnder(p, clean(d)))) {
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
