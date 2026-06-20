import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { createGuardedFetch, PROVIDER_FETCH_TIMEOUT_MS } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls } from "@/lib/settings";

export type AuthKind = "token" | "oauth";

/** Decide whether a remote MCP server expects OAuth. We run the SAME discovery the
 *  runtime `auth()` does (`discoverOAuthServerInfo`): RFC 9728 protected-resource
 *  metadata if advertised, else fall back to the server root as the authorization
 *  server and probe its RFC 8414 / OIDC metadata. Authorization-server metadata
 *  present → 'oauth'; otherwise → 'token' (the safe default). Probing only RFC 9728
 *  used to misclassify providers that expose OAuth solely via RFC 8414 (e.g. servers
 *  whose only well-known is /.well-known/oauth-authorization-server) as 'token',
 *  which then surfaced a misleading "token rejected" on the Test button. The
 *  request is SSRF-guarded + timeout-bounded (URL is user-supplied). Never throws. */
export async function detectAuthKind(url: string): Promise<AuthKind> {
  try {
    const fetchFn = createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), timeoutMs: PROVIDER_FETCH_TIMEOUT_MS });
    const info = await discoverOAuthServerInfo(url, { fetchFn });
    return info.authorizationServerMetadata ? "oauth" : "token";
  } catch {
    return "token";
  }
}
