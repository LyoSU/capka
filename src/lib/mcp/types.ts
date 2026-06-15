import type { SecretDescriptor } from "@/lib/skills/types";

export type McpScope = "system" | "user" | "project";
export type McpTransport = "http" | "sse" | "stdio"; // B1 implements 'http' only

/** Decrypted secrets used at connect time. `env` is for stdio (B2). */
export interface McpSecrets {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export type McpAuthKind = "token" | "oauth";

/** Runtime config after decryption — what connectMcpServer needs. */
export interface McpServerConfig {
  id?: string;
  name: string;
  transport: McpTransport;
  url: string;
  secrets?: McpSecrets;
  authKind?: McpAuthKind;
}

/** A server row as served to load/UI (no decrypted secrets). */
export interface McpServerInfo {
  id: string;
  scope: McpScope;
  name: string;
  transport: McpTransport;
  url: string | null;
  enabled: boolean;
  authKind: McpAuthKind;
}

/** Forward-compat seam: connectors declare required secrets for the catalog. */
export type { SecretDescriptor };
