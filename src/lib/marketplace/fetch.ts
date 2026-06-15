import { resolveGitHub } from "./source";
import type { CatalogItem, PluginSource } from "./types";

/** One entry of a recursive git tree. */
export interface TreeEntry { path: string; type: "blob" | "tree" }

/** Recursive git tree for a repo ref — the full file list in one request. */
export async function ghTree(
  owner: string,
  repo: string,
  ref: string,
  fetchFn: typeof fetch,
): Promise<TreeEntry[]> {
  const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!res.ok) throw new Error(`GitHub tree ${owner}/${repo}@${ref}: HTTP ${res.status}`);
  const json = (await res.json()) as { tree?: { path: string; type: string }[] };
  return (json.tree ?? []).map((t) => ({ path: t.path, type: t.type === "tree" ? "tree" : "blob" }));
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
