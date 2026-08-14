import type { SecretDescriptor } from "@/lib/skills/types";

export type McpScope = "system" | "user" | "project";
export type McpTransport = "http" | "sse" | "stdio";

/** Which protocol a remote MCP endpoint speaks, guessed from its URL.
 *
 *  Streamable HTTP superseded the older HTTP+SSE pair, but a lot of deployed
 *  servers still only offer SSE and publish that endpoint as `…/sse` — the
 *  convention from the original spec. Guessing keeps adding a connector a
 *  paste-the-URL affair instead of asking a non-technical admin which MCP
 *  protocol version their vendor implements. An explicit `transport` on the row
 *  always wins, so a server that breaks the convention stays reachable. */
export function inferRemoteTransport(url: string): "http" | "sse" {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
    if (path === "/sse" || path.endsWith("/sse")) return "sse";
  } catch {
    /* not a parseable URL — upsert's assertSafeUrl is what rejects it */
  }
  return "http";
}

/** Decrypted secrets used at connect time. `env` is for stdio (B2). */
export interface McpSecrets {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export type McpAuthKind = "token" | "oauth";

/** Runtime config after decryption — what connectMcpServer needs.
 *  http/sse: `url` is set. stdio: `command` (+ optional `args`, `secrets.env`) is
 *  set and the server is reached by bridging through the session sandbox. */
export interface McpServerConfig {
  id?: string;
  name: string;
  transport: McpTransport;
  url: string;
  command?: string;
  args?: string[];
  secrets?: McpSecrets;
  authKind?: McpAuthKind;
  /** Provenance tag (e.g. `catalog:<installId>`). Lets the runtime materialize a
   *  plugin's bundled files for a stdio server that references ${CLAUDE_PLUGIN_ROOT}. */
  source?: string;
}

/** A server row as served to load/UI (no decrypted secrets). */
export interface McpServerInfo {
  id: string;
  scope: McpScope;
  name: string;
  transport: McpTransport;
  url: string | null;
  /** Effective state for the requesting user: a shared connector reads its
   *  global flag AND this user's mute; an own connector reads its own flag. */
  enabled: boolean;
  authKind: McpAuthKind;
  /** The requesting user owns this (a personal, user-scope connector). */
  mine?: boolean;
  /** The plugin that installed this connector is gone, so nothing can use it and no
   *  Extensions row manages it — it appears in the list only to be deleted. Set by the
   *  management listing; absent everywhere the question does not arise. */
  orphaned?: boolean;
}

/** Forward-compat seam: connectors declare required secrets for the catalog. */
export type { SecretDescriptor };
