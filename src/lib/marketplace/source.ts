import type { GitHubRef, PluginSource } from "./types";

/** Parse a GitHub repo reference from a URL or `owner/repo` shorthand. */
export function parseGitHubUrl(raw: string): { owner: string; repo: string } | null {
  const s = raw.trim();
  // owner/repo shorthand (no scheme, no host)
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (!s.includes("://") && short) return { owner: short[1], repo: short[2] };
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
  const parts = u.pathname.replace(/^\/+/, "").split("/");
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

const cleanSubdir = (p?: string) => (p ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");

/**
 * Resolve a plugin `source` to a GitHub location. `marketplace` supplies the repo
 * for bare relative-path sources (the plugin lives inside the marketplace repo).
 * sha wins over ref; missing both → "HEAD". Returns null for non-GitHub sources.
 */
export function resolveGitHub(
  source: PluginSource,
  marketplace: { owner: string; repo: string },
): GitHubRef | null {
  if (typeof source === "string") {
    return { owner: marketplace.owner, repo: marketplace.repo, ref: "HEAD", subdir: cleanSubdir(source) };
  }
  const ref = source.sha || source.ref || "HEAD";
  const subdir = cleanSubdir(source.path);
  const fromUrl = source.url ? parseGitHubUrl(source.url) : source.repo ? parseGitHubUrl(source.repo) : null;
  if (!fromUrl) {
    // No url/repo given but a relative-style source object → treat path as in-repo.
    if (!source.url && !source.repo && subdir) {
      return { owner: marketplace.owner, repo: marketplace.repo, ref, subdir };
    }
    return null;
  }
  return { owner: fromUrl.owner, repo: fromUrl.repo, ref, subdir };
}
