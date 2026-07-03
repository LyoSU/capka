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

const isUnder = (p, root) =>
  root === "/" ? true : p === root || p.startsWith(root + "/");

export function validateMountPath(hostPath, { dataRoot, hostDataRoot, allowRoots = [] }) {
  if (typeof hostPath !== "string" || hostPath.includes("\0") || !hostPath.startsWith("/")) {
    return { ok: false, code: "not_absolute" };
  }
  let p = normalize(hostPath);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p.includes("..")) return { ok: false, code: "denied" };
  // "/" denies only the exact filesystem root; every other entry denies the
  // path itself and anything under it. (isUnder treats "/" as "contains all",
  // which is what we want for the allowlist below but not here.)
  if (p === "/" || DENY.some((d) => d !== "/" && isUnder(p, d))) {
    return { ok: false, code: "denied" };
  }
  for (const dr of [dataRoot, hostDataRoot].filter(Boolean)) {
    // contains, is, or is contained by the data root — all leak workspaces
    if (isUnder(p, dr) || isUnder(dr, p)) return { ok: false, code: "denied" };
  }
  if (allowRoots.length && !allowRoots.some((r) => isUnder(p, normalize(r)))) {
    return { ok: false, code: "outside_allowlist" };
  }
  return { ok: true, path: p };
}
