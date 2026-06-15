import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { requireSession } from "@/lib/auth";
import { getAccessibleServer } from "@/lib/mcp/service";
import { McpOAuthProvider } from "@/lib/mcp/oauth/provider";
import { createGuardedFetch } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls } from "@/lib/settings";

/** Begin the OAuth sign-in for a connector: discover + (DCR) + PKCE, then 302 the
 *  user's browser to the provider's authorization page. On any failure we bounce
 *  back to the connectors page with a friendly error flag (no raw JSON). */
export async function GET(req: Request) {
  const settings = (q: string) => Response.redirect(new URL(`/settings/connectors${q}`, req.url), 302);
  let userId: string;
  try {
    ({ userId } = await requireSession());
  } catch {
    return Response.redirect(new URL("/login", req.url), 302);
  }
  try {
    const serverId = new URL(req.url).searchParams.get("serverId");
    if (!serverId) return settings("?error=oauth");
    const server = await getAccessibleServer(userId, serverId);
    if (!server || !server.url || server.authKind !== "oauth") return settings("?error=oauth");

    const provider = new McpOAuthProvider(userId, server.id, "flow");
    const fetchFn = createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls() });
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
