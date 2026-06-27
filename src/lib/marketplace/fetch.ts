import { resolveGitHub } from "./source";
import type { CatalogItem, CommitInfo, PluginSource } from "./types";

/** One entry of a recursive git tree. `sha` is the git blob/tree object id — a
 *  content hash, so two trees can be diffed precisely by comparing it per path. */
export interface TreeEntry { path: string; type: "blob" | "tree"; sha: string }

/**
 * Resolve a ref (branch / tag / "HEAD" / a SHA) to a concrete commit — the pin.
 * Fetching the tree + files AT this SHA gives a consistent snapshot (no TOCTOU if
 * the branch moves mid-install) and records exactly which bytes were installed.
 * Passing a SHA returns that same SHA, so it is idempotent.
 */
export async function resolveCommit(
  owner: string,
  repo: string,
  ref: string,
  fetchFn: typeof fetch,
): Promise<CommitInfo> {
  const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!res.ok) throw new Error(`GitHub commit ${owner}/${repo}@${ref}: HTTP ${res.status}`);
  const json = (await res.json()) as {
    sha?: string;
    commit?: { message?: string; author?: { date?: string }; committer?: { date?: string } };
  };
  if (!json.sha) throw new Error(`GitHub commit ${owner}/${repo}@${ref}: no sha in response`);
  return {
    sha: json.sha,
    date: json.commit?.committer?.date ?? json.commit?.author?.date ?? null,
    message: json.commit?.message?.split("\n")[0] ?? null,
  };
}

/** Recursive git tree for a repo ref — the full file list in one request. */
export async function ghTree(
  owner: string,
  repo: string,
  ref: string,
  fetchFn: typeof fetch,
): Promise<TreeEntry[]> {
  const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!res.ok) throw new Error(`GitHub tree ${owner}/${repo}@${ref}: HTTP ${res.status}`);
  const json = (await res.json()) as { tree?: { path: string; type: string; sha?: string }[] };
  return (json.tree ?? []).map((t) => ({ path: t.path, type: t.type === "tree" ? "tree" : "blob", sha: t.sha ?? "" }));
}

/** A path-level diff between two trees, relative to the plugin prefix. */
export interface TreeDiff { added: string[]; removed: string[]; modified: string[] }

/**
 * Compare two recursive trees by each blob's content-sha, within `prefix`,
 * returning the plugin-relative paths that were added / removed / modified.
 * Directories (tree entries) are ignored — only files matter for review. This is
 * the basis of the upgrade preview: it shows an operator exactly what an update
 * changes before they move the pin, so a new server file can't slip in unseen.
 */
export function diffTrees(oldTree: TreeEntry[], newTree: TreeEntry[], prefix = ""): TreeDiff {
  const blobs = (t: TreeEntry[]) => {
    const m = new Map<string, string>();
    for (const e of t) if (e.type === "blob" && e.path.startsWith(prefix)) m.set(e.path.slice(prefix.length), e.sha);
    return m;
  };
  const a = blobs(oldTree);
  const b = blobs(newTree);
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [path, sha] of b) {
    if (!a.has(path)) added.push(path);
    else if (a.get(path) !== sha) modified.push(path);
  }
  for (const path of a.keys()) if (!b.has(path)) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

/** Fetch one file as text via raw.githubusercontent. null on 404. */
export async function ghRaw(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const res = await fetchFn(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub raw ${path}: HTTP ${res.status}`);
  return res.text();
}

const authorName = (a: unknown): string | null =>
  typeof a === "string" ? a : a && typeof a === "object" && typeof (a as { name?: string }).name === "string" ? (a as { name: string }).name : null;

/**
 * Normalize a parsed marketplace.json into CatalogItems. Tolerant + total: a
 * malformed plugin entry is skipped (not fatal); unknown fields are ignored.
 * `installable` reflects whether the source resolves to a GitHub location (C1).
 */
export function parseMarketplace(
  json: unknown,
  marketplace: { owner: string; repo: string },
): { name: string; owner: string | null; items: CatalogItem[] } {
  const root = (json ?? {}) as { name?: string; owner?: unknown; plugins?: unknown[] };
  const items: CatalogItem[] = [];
  for (const raw of Array.isArray(root.plugins) ? root.plugins : []) {
    const p = raw as { name?: string; description?: string; author?: unknown; category?: string; homepage?: string; source?: PluginSource };
    if (!p || typeof p.name !== "string") continue;
    const source: PluginSource = p.source ?? p.name; // fallback: bare relative path = name
    items.push({
      name: p.name,
      description: typeof p.description === "string" ? p.description : "",
      author: authorName(p.author),
      category: typeof p.category === "string" ? p.category : null,
      homepage: typeof p.homepage === "string" ? p.homepage : null,
      kind: "plugin",
      source,
      installable: resolveGitHub(source, marketplace) !== null,
    });
  }
  return { name: typeof root.name === "string" ? root.name : marketplace.repo, owner: authorName(root.owner), items };
}
