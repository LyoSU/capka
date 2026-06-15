/** The polymorphic `source` field of a marketplace plugin entry. */
export type PluginSource =
  | string // bare relative path within the marketplace repo
  | {
      source?: string; // 'git-subdir' | 'github' | 'git' | 'npm' | 'url'
      url?: string;
      repo?: string; // owner/repo (github form)
      path?: string; // subdir (git-subdir)
      ref?: string;
      sha?: string;
    };

/** Where a plugin's files live on GitHub, resolved from its source. */
export interface GitHubRef {
  owner: string;
  repo: string;
  ref: string; // sha > ref > "HEAD"
  subdir: string; // "" for repo root
}

export type CatalogKind = "skill" | "mcp" | "plugin";

/** Normalized, display-ready plugin entry (the federation target). */
export interface CatalogItem {
  name: string;
  description: string;
  author: string | null;
  category: string | null;
  homepage: string | null;
  kind: CatalogKind;
  source: PluginSource;
  installable: boolean; // false for non-GitHub sources in C1
}

/** What an install routed, for status + uninstall. */
export interface InstallManifest {
  skills: string[];
  connectors: string[];
  ignored: { type: string; count: number }[];
  notes: string[];
}
