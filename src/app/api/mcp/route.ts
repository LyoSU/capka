import { apiHandler, requireSession, requireActive } from "@/lib/auth";
import { listServers, upsertServer, setEnabled, deleteServer } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { saveOAuthClientFromInput } from "@/lib/mcp/oauth/admin-client";
import { setMuted } from "@/lib/muted-resources";
import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  return Response.json({ servers: await listServers(userId, null) });
});

export const POST = apiHandler(async (req: Request) => {
  // Mutations are install-class (a connector runs SSRF-guarded probes / third-party
  // tools), so a pending account may not create them — requireActive, not session.
  const { userId } = await requireActive();
  const { name, url, headers, oauthClientId, oauthClientSecret, authKind: pick } = await req.json();
  if (typeof name !== "string" || typeof url !== "string") {
    return Response.json({ error: "name and url required" }, { status: 400 });
  }
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  // A pre-registered client (advanced) forces OAuth; an explicit method from the form
  // is authoritative ('none' is stored as 'token' with no secrets = open). We only
  // fall back to probing when the caller didn't say.
  const authKind =
    oauthClientId ? "oauth" : pick === "oauth" || pick === "token" ? pick : await detectAuthKind(url);
  const id = await upsertServer({ scope: "user", userId, projectId: null, name, url, secrets, authKind });
  await saveOAuthClientFromInput(id, oauthClientId, oauthClientSecret);
  return Response.json({ ok: true, id, authKind });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const [row] = await db.select({ scope: mcpServers.scope, userId: mcpServers.userId })
    .from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  if (row.scope === "user") {
    if (row.userId !== userId) return Response.json({ error: "Not yours" }, { status: 404 });
    await setEnabled(id, enabled);
  } else if (row.scope === "system") {
    // Shared connector: mute/unmute for this user only (admins flip the global
    // flag via /api/admin/mcp). enabled=false → muted.
    await setMuted(userId, "mcp", id, !enabled);
  } else {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const owned = await db.select({ id: mcpServers.id }).from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId), eq(mcpServers.scope, "user"))).limit(1);
  if (!owned[0]) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  await deleteServer(id);
  return Response.json({ ok: true });
});
