import type { SecretDescriptor } from "@/lib/skills/types";

export type McpScope = "system" | "user" | "project";
export type McpTransport = "http" | "sse" | "stdio"; // B1 implements 'http' only

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
}

/** Forward-compat seam: connectors declare required secrets for the catalog. */
export type { SecretDescriptor };
