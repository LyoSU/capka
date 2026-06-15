import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { createGuardedFetch } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls } from "@/lib/settings";

export type AuthKind = "token" | "oauth";

/** Decide whether a remote MCP server expects OAuth by probing its RFC 9728
 *  protected-resource metadata. Present → 'oauth'; absent/unreachable → 'token'
 *  (the safe default). The discovery request is SSRF-guarded (the URL is
 *  user-supplied and this runs before the row is persisted/validated). Never throws. */
export async function detectAuthKind(url: string): Promise<AuthKind> {
  try {
    const fetchFn = createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls() });
    const meta = await discoverOAuthProtectedResourceMetadata(url, undefined, fetchFn);
    return meta ? "oauth" : "token";
  } catch {
    return "token";
  }
}
