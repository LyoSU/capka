import { apiHandler, requireSession } from "@/lib/auth";
import { listServers, upsertServer, setEnabled, deleteServer } from "@/lib/mcp/service";
import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  return Response.json({ servers: await listServers(userId, null) });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { name, url, headers } = await req.json();
  if (typeof name !== "string" || typeof url !== "string") {
    return Response.json({ error: "name and url required" }, { status: 400 });
  }
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const id = await upsertServer({ scope: "user", userId, projectId: null, name, url, secrets });
  return Response.json({ ok: true, id });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const owned = await db.select({ id: mcpServers.id }).from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId), eq(mcpServers.scope, "user"))).limit(1);
  if (!owned[0]) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  await setEnabled(id, enabled);
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const owned = await db.select({ id: mcpServers.id }).from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId), eq(mcpServers.scope, "user"))).limit(1);
  if (!owned[0]) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  await deleteServer(id);
  return Response.json({ ok: true });
});
