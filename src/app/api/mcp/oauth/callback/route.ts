import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { requireSession } from "@/lib/auth";
import { getAccessibleServer } from "@/lib/mcp/service";
import { McpOAuthProvider } from "@/lib/mcp/oauth/provider";
import { consumeState } from "@/lib/mcp/oauth/store";
import { createGuardedFetch, PROVIDER_FETCH_TIMEOUT_MS } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { getPublicUrl } from "@/lib/url";
import { recordConnectError } from "@/lib/mcp/connect-errors";
import { errorText } from "@/lib/errors/message";

/** A tiny interstitial that ENDS the OAuth round-trip whether it happened in a
 *  popup (opened by a chat card — postMessage the opener, then close) or a full
 *  navigation (the settings page, or a Telegram in-app browser — just redirect).
 *  Self-determining via window.opener, so one response serves both and the old
 *  full-navigation behavior is unchanged. Values are JSON-encoded and <-escaped
 *  so a connector name can't break out of the inline script. */
function oauthResultPage(target: string, ok: boolean, name?: string): Response {
  const j = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in complete</title></head>
<body style="font:15px system-ui;margin:2rem;color:#555">
<script>(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:"capka:oauth",ok:${j(ok)},name:${j(name)}},location.origin);window.close();return;}}catch(e){}location.replace(${j(target)});})();</script>
<p>You can close this window.</p></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** OAuth redirect target: exchange the authorization code for per-user tokens.
 *  Validates the single-use state and that it belongs to the signed-in user. */
export async function GET(req: Request) {
  // Build redirects off the PUBLIC origin (PUBLIC_URL / X-Forwarded-Host), not
  // req.url — behind a proxy the latter is the internal bind (e.g. 0.0.0.0:3000).
  const base = getPublicUrl({ headers: req.headers });
  const settings = (q: string, tab = "connectors", name?: string) =>
    oauthResultPage(`${base}/settings/skills?tab=${tab}${q.replace("?", "&")}`, !q.includes("error"), name);
  let userId: string;
  try {
    ({ userId } = await requireSession());
  } catch {
    return Response.redirect(`${base}/login`, 302);
  }
  let serverId: string | undefined;
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (url.searchParams.get("error") || !code || !state) return settings("?error=oauth");

    const flight = await consumeState(state);
    // State must exist, be fresh, and belong to THIS user (anti code-injection).
    if (!flight || flight.userId !== userId) return settings("?error=oauth");
    serverId = flight.serverId;

    const server = await getAccessibleServer(userId, flight.serverId);
    if (!server || !server.url) return settings("?error=oauth");

    const provider = new McpOAuthProvider(userId, server.id, "callback", flight.codeVerifier);
    const fetchFn = createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), timeoutMs: PROVIDER_FETCH_TIMEOUT_MS });
    const result = await auth(provider, { serverUrl: server.url, authorizationCode: code, fetchFn });
    if (result !== "AUTHORIZED") return settings("?error=oauth");
    const tab = server.source?.startsWith("catalog:") ? "plugins" : "connectors";
    return settings(`?connected=${encodeURIComponent(server.name)}`, tab, server.name);
  } catch (e) {
    console.warn("[mcp-oauth] callback failed:", e);
    if (serverId) recordConnectError(userId, serverId, errorText(e));
    return settings("?error=oauth");
  }
}
