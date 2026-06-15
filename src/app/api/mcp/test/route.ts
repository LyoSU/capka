import { apiHandler, requireSession } from "@/lib/auth";
import { probeConfig } from "@/lib/mcp/health";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { getBlockPrivateProviderUrls } from "@/lib/settings";

/** Test a connector before saving it — connect + listTools against a transient
 *  config (never persisted) so the user gets instant "✓ works / ⚠ token rejected"
 *  feedback in the add form. SSRF-guarded inside connectMcpServer. */
export const POST = apiHandler(async (req: Request) => {
  await requireSession();
  const { url, headers } = await req.json();
  if (typeof url !== "string" || !url.trim()) {
    return Response.json({ error: "url required" }, { status: 400 });
  }
  // An OAuth server can't be tested before saving (no token yet) — tell the user
  // to save and sign in instead of showing a misleading "token rejected".
  if (await detectAuthKind(url) === "oauth") {
    return Response.json({ status: "needs_login" });
  }
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const blockPrivate = await getBlockPrivateProviderUrls();
  const health = await probeConfig({ name: "probe", url, secrets }, blockPrivate);
  return Response.json(health);
});
