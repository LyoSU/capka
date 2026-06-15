import { apiHandler, requireSession } from "@/lib/auth";
import { getAccessibleServer } from "@/lib/mcp/service";
import { deleteUserTokens } from "@/lib/mcp/oauth/store";

/** Sign out of a connector — drops this user's stored OAuth tokens for it. The
 *  connector itself stays; the row reverts to "needs sign-in". */
export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const serverId = new URL(req.url).searchParams.get("serverId");
  if (!serverId) return Response.json({ error: "serverId required" }, { status: 400 });
  const server = await getAccessibleServer(userId, serverId);
  if (!server) return Response.json({ error: "Not found" }, { status: 404 });
  await deleteUserTokens(userId, serverId);
  return Response.json({ ok: true });
});
