import { apiHandler, requireActive } from "@/lib/auth";
import { probeConfig } from "@/lib/mcp/health";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { take } from "@/lib/rate-limit";

export type AuthMethod = "none" | "token" | "oauth";

/** Best-effort friendly name from the URL host when we can't read the server's own
 *  serverInfo (e.g. an OAuth server that won't talk to us before sign-in).
 *  `https://mcp.notion.com/sse` → "notion". Strips a leading api./mcp./www. and the
 *  TLD, keeping the registrable label. */
function nameFromHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^(api|mcp|www)\./, "");
    const label = host.split(".")[0];
    return label || undefined;
  } catch {
    return undefined;
  }
}

/** Inspect a connector URL before saving so the add form can do the work for the
 *  user: auto-detect the auth method, auto-fill the name (server's own serverInfo,
 *  else the host), and report reachability. Connects against a transient config that
 *  is never persisted. SSRF-guarded inside connectMcpServer.
 *
 *  Returns `{ status, method, serverName?, toolCount? }`:
 *   - OAuth servers can't be probed before sign-in → `needs_login` + a host-derived
 *     name (no misleading "token rejected").
 *   - Otherwise we probe: connecting with no token and succeeding means the server is
 *     open (`none`); a 401/403 means it wants a key (`token`). A token in the request
 *     (the explicit "Test" button) that connects confirms `token`. */
export const POST = apiHandler(async (req: Request) => {
  // requireActive (not session): probing connects out to an arbitrary URL, so a
  // pending/rejected account must not be able to use it.
  const { userId } = await requireActive();
  const rl = take(`mcp-test:${userId}`);
  if (!rl.ok) return Response.json({ error: "Too many requests — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  const { url, headers } = await req.json();
  if (typeof url !== "string" || !url.trim()) {
    return Response.json({ error: "url required" }, { status: 400 });
  }
  if ((await detectAuthKind(url)) === "oauth") {
    return Response.json({ status: "needs_login", method: "oauth" as AuthMethod, serverName: nameFromHost(url) });
  }
  const hasToken = headers && typeof headers === "object";
  const secrets = hasToken ? { headers } : undefined;
  const blockPrivate = await getBlockPrivateProviderUrls();
  const health = await probeConfig({ name: "probe", url, secrets }, blockPrivate);
  // ok without a token → open; ok with a token, or a rejection, → token. Unreachable
  // leaves the method unset so the form keeps the user's (or default) choice.
  const method: AuthMethod | undefined =
    health.status === "ok" ? (hasToken ? "token" : "none") : health.status === "unauthorized" ? "token" : undefined;
  return Response.json({ ...health, ...(method ? { method } : {}) });
});
