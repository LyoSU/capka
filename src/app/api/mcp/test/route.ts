import { apiHandler, requireSession } from "@/lib/auth";
import { probeConfig } from "@/lib/mcp/health";
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
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const blockPrivate = await getBlockPrivateProviderUrls();
  const health = await probeConfig({ name: "probe", url, secrets }, blockPrivate);
  return Response.json(health);
});
