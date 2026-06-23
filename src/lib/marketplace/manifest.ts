import { sanitizeBundlePath } from "@/lib/skills/paths";

/** One MCP server definition as it appears in a plugin's `.mcp.json` or the
 *  inline `mcpServers` map in `.claude-plugin/plugin.json`. */
export interface ServerDef {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Tolerate a missing `mcpServers` wrapper (some real `.mcp.json` files omit it):
 *  unwrap `{ mcpServers: {...} }` when present, otherwise treat the object itself
 *  as the server map. */
export function extractServers(json: unknown): Record<string, ServerDef> {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (o.mcpServers && typeof o.mcpServers === "object" && !Array.isArray(o.mcpServers)) {
      return o.mcpServers as Record<string, ServerDef>;
    }
    return o as Record<string, ServerDef>;
  }
  return {};
}

/**
 * Split a plugin manifest's `mcpServers` field into inline server defs and
 * referenced config-file paths. Per the Claude Code plugin schema the field is
 * `string | array | object`: a path to a config file, an array mixing paths and
 * inline maps, or a single inline map. Paths are normalized relative to the
 * plugin root and traversal/absolute paths are dropped (zip-slip guard).
 */
export function parseManifestMcp(value: unknown): { inline: Record<string, ServerDef>; paths: string[] } {
  const inline: Record<string, ServerDef> = {};
  const paths: string[] = [];

  const take = (v: unknown) => {
    if (typeof v === "string") {
      const safe = sanitizeBundlePath(v);
      if (safe) paths.push(safe);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(inline, extractServers(v));
    }
  };

  if (Array.isArray(value)) value.forEach(take);
  else take(value);

  return { inline, paths };
}
