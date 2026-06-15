import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";

export type AuthKind = "token" | "oauth";

/** Decide whether a remote MCP server expects OAuth by probing its RFC 9728
 *  protected-resource metadata. Present → 'oauth'; absent/unreachable → 'token'
 *  (the safe default — a static-token or open server). Never throws. */
export async function detectAuthKind(url: string): Promise<AuthKind> {
  try {
    const meta = await discoverOAuthProtectedResourceMetadata(url);
    return meta ? "oauth" : "token";
  } catch {
    return "token";
  }
}
