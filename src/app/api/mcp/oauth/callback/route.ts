import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { requireSession } from "@/lib/auth";
import { getAccessibleServer } from "@/lib/mcp/service";
import { McpOAuthProvider } from "@/lib/mcp/oauth/provider";
import { consumeState } from "@/lib/mcp/oauth/store";
import { createGuardedFetch, PROVIDER_FETCH_TIMEOUT_MS } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { getPublicUrl } from "@/lib/url";

/** OAuth redirect target: exchange the authorization code for per-user tokens.
 *  Validates the single-use state and that it belongs to the signed-in user. */
export async function GET(req: Request) {
  // Build redirects off the PUBLIC origin (PUBLIC_URL / X-Forwarded-Host), not
  // req.url — behind a proxy the latter is the internal bind (e.g. 0.0.0.0:3000).
  const base = getPublicUrl({ headers: req.headers });
  const settings = (q: string) => Response.redirect(`${base}/settings/skills?tab=connectors${q.replace("?", "&")}`, 302);
  let userId: string;
  try {
    ({ userId } = await requireSession());
  } catch {
    return Response.redirect(`${base}/login`, 302);
  }
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (url.searchParams.get("error") || !code || !state) return settings("?error=oauth");

    const flight = await consumeState(state);
    // State must exist, be fresh, and belong to THIS user (anti code-injection).
    if (!flight || flight.userId !== userId) return settings("?error=oauth");

    const server = await getAccessibleServer(userId, flight.serverId);
    if (!server || !server.url) return settings("?error=oauth");

    const provider = new McpOAuthProvider(userId, server.id, "callback", flight.codeVerifier);
    const fetchFn = createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), timeoutMs: PROVIDER_FETCH_TIMEOUT_MS });
    const result = await auth(provider, { serverUrl: server.url, authorizationCode: code, fetchFn });
    if (result !== "AUTHORIZED") return settings("?error=oauth");
    return settings(`?connected=${encodeURIComponent(server.name)}`);
  } catch (e) {
    console.warn("[mcp-oauth] callback failed:", e);
    return settings("?error=oauth");
  }
}
