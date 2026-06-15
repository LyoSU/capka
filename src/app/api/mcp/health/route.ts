import { apiHandler, requireSession } from "@/lib/auth";
import { probeUserServers } from "@/lib/mcp/health";

/** Live connection health for the current user's connectors — drives the status
 *  badges in /settings/connectors. Results are cached ~60s server-side. */
export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  return Response.json({ health: await probeUserServers(userId) });
});
