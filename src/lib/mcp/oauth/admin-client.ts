import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpOAuthProvider } from "./provider";
import { saveClientInfo } from "./store";

/** Persist an operator-supplied OAuth client (the "Advanced settings" Client ID /
 *  Secret in the add form) so the flow skips Dynamic Client Registration. No-op
 *  when no client id was given (DCR covers the common case). */
export async function saveOAuthClientFromInput(
  serverId: string,
  clientId: unknown,
  clientSecret: unknown,
): Promise<void> {
  if (typeof clientId !== "string" || !clientId.trim()) return;
  // redirect_uris must match what the flow advertises.
  const redirectUrl = new McpOAuthProvider("", serverId, "flow").redirectUrl;
  const info = {
    client_id: clientId.trim(),
    ...(typeof clientSecret === "string" && clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
    redirect_uris: [redirectUrl],
  } as OAuthClientInformationFull;
  await saveClientInfo(serverId, info);
}
