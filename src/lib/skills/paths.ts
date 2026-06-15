/**
 * Normalize and validate a path from an untrusted skill bundle.
 * Returns the safe relative path, or null if it must be rejected
 * (absolute, traversal, empty). Protects against zip-slip.
 */
export function sanitizeBundlePath(p: string): string | null {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!norm || norm === ".") return null;
  if (norm.startsWith("/")) return null;
  const segs = norm.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs.join("/");
}
