import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { requireSession } from "@/lib/auth";
import { getAccessibleServer } from "@/lib/mcp/service";
import { McpOAuthProvider } from "@/lib/mcp/oauth/provider";
import { createGuardedFetch, PROVIDER_FETCH_TIMEOUT_MS } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { getPublicUrl } from "@/lib/url";

/** Begin the OAuth sign-in for a connector: discover + (DCR) + PKCE, then 302 the
 *  user's browser to the provider's authorization page. On any failure we bounce
 *  back to the connectors page with a friendly error flag (no raw JSON). */
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
    const serverId = new URL(req.url).searchParams.get("serverId");
    if (!serverId) return settings("?error=oauth");
    const server = await getAccessibleServer(userId, serverId);
    if (!server || !server.url || server.authKind !== "oauth") return settings("?error=oauth");

    const provider = new McpOAuthProvider(userId, server.id, "flow");
    const fetchFn = createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), timeoutMs: PROVIDER_FETCH_TIMEOUT_MS });
    const result = await auth(provider, { serverUrl: server.url, fetchFn });
    if (result === "REDIRECT" && provider.capturedAuthUrl) {
      return Response.redirect(provider.capturedAuthUrl.toString(), 302);
    }
    // Already authorized (tokens present) — nothing to do.
    return settings(`?connected=${encodeURIComponent(server.name)}`);
  } catch (e) {
    console.warn("[mcp-oauth] start failed:", e);
    return settings("?error=oauth");
  }
}
