import { createHash } from "node:crypto";

/**
 * Turning a value into bytes that a fingerprint or a comparison can be built on.
 *
 * Everything here exists so that "the same" and "different" are decidable properties
 * of an install rather than judgement calls (docs/plugin-install-review-spec.md §4).
 * The consent gate reads these comparisons, so an encoding that lets two different
 * command lines produce one value is a way to slip a change past a review.
 */

/** What can appear in a canonical value: plan-derived data, never a Date or a class. */
export type CanonValue = string | number | boolean | null | undefined | CanonValue[] | { [k: string]: CanonValue };

/** `<byteLength>:<payload>`. The prefix is what makes concatenation unambiguous. */
function lp(s: string): string {
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
}

/**
 * A value paired with the field path it sits at, encoded so that no two distinct
 * (path, value) pairs share bytes.
 *
 * Three properties are load-bearing:
 *
 * - **The path is inside the value.** A fingerprint of `args[0]` must not be
 *   interchangeable with one of `env.TOKEN`, or the same secret moved between them
 *   would read as unchanged.
 * - **Composites are length-prefixed, never joined.** `["a","bc"]` and `["ab","c"]`
 *   must differ, so a shifted argument boundary is visible.
 * - **Types are tagged.** `"1"` and `1`, and `null` and `"null"`, are different
 *   values and a review that conflated them would show no diff where there is one.
 *
 * Object keys are sorted because a key set has no order; array elements are NOT,
 * because argv is a sequence and reordering it changes what runs.
 */
export function canonicalTypedValue(path: string, value: CanonValue): string {
  if (value === undefined) return `L${lp(path)}u${lp("")}`;
  if (value === null) return `L${lp(path)}z${lp("")}`;
  if (typeof value === "string") return `L${lp(path)}s${lp(value)}`;
  if (typeof value === "number") return `L${lp(path)}n${lp(String(value))}`;
  if (typeof value === "boolean") return `L${lp(path)}b${lp(value ? "1" : "0")}`;
  if (Array.isArray(value)) {
    return `A${lp(path)}${lp(value.map((v, i) => canonicalTypedValue(`${path}[${i}]`, v)).join(""))}`;
  }
  const keys = Object.keys(value).sort();
  return `O${lp(path)}${lp(keys.map((k) => canonicalTypedValue(`${path}.${k}`, value[k])).join(""))}`;
}

/**
 * SHA-256 over raw bytes with NO normalization — not of whitespace, not of Unicode,
 * not of line endings.
 *
 * So a whitespace-only edit reads as a change. That is the intended trade: normalizing
 * is itself an attack surface (zero-width characters, homoglyphs, bidi controls), and
 * in a consent feature a false positive costs a re-review while a false negative hides
 * a modification the installer was entitled to see.
 */
export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * One hash standing for a whole file set: over sorted `(path, contentHash)` pairs, so
 * it is order-independent (the tree is a set of files, not a list) yet path-bound —
 * moving identical bytes to a different path is a change.
 */
export function rootHash(entries: { path: string; contentHash: string }[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return contentHash(`capka:plugin-tree:v1${sorted.map((e) => lp(e.path) + lp(e.contentHash)).join("")}`);
}

/** A connector's destination, reduced to what may be shown: no values of any kind. */
export interface NormalizedEndpoint {
  scheme: string;
  host: string;
  /** Always explicit — 443/80 filled in, so `https://h` and `https://h:443` are one
   *  endpoint rather than a spurious diff. */
  port: number;
  pathname: string;
  /** Parameter NAMES only, sorted. A query value can carry a token. */
  queryKeys: string[];
}

export function normalizeEndpoint(raw: string): NormalizedEndpoint | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const scheme = u.protocol.replace(/:$/, "");
  const port = u.port ? Number(u.port) : scheme === "https" ? 443 : scheme === "http" ? 80 : 0;
  // Trailing slash dropped so `/mcp` and `/mcp/` are one path, but a bare root stays
  // "/" — collapsing it to "" would make the root indistinguishable from an absent path.
  const pathname = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  // `username`/`password` are deliberately not read: URL credentials are secrets, and
  // this shape reaches the client.
  return { scheme, host: u.hostname.toLowerCase(), port, pathname, queryKeys: [...new Set(u.searchParams.keys())].sort() };
}
