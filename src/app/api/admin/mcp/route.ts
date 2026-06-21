import { apiHandler, requireAdmin } from "@/lib/auth";
import { upsertServer, upsertStdioServer, setEnabled, deleteServer } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { saveOAuthClientFromInput } from "@/lib/mcp/oauth/admin-client";
import { audit } from "@/lib/governance/audit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const body = await req.json();
  const { name, url, headers, scope, projectId, oauthClientId, oauthClientSecret, command, args, env } = body;
  const s = scope === "project" ? "project" : "system";

  // Local (stdio) connector — admin only; runs inside the session sandbox.
  if (typeof command === "string" && command.trim()) {
    if (typeof name !== "string") return Response.json({ error: "name required" }, { status: 400 });
    const id = await upsertStdioServer({
      scope: s, userId: null, projectId: s === "project" ? (projectId ?? null) : null,
      name, command,
      args: Array.isArray(args) ? args.filter((a: unknown): a is string => typeof a === "string") : undefined,
      env: env && typeof env === "object" ? env : undefined,
    });
    await audit({ actorId: userId, action: "connector.add", targetType: "connector", targetKey: name, detail: { scope: s, transport: "stdio" } });
    return Response.json({ ok: true, id, authKind: "token" });
  }

  if (typeof name !== "string" || typeof url !== "string") {
    return Response.json({ error: "name and url required" }, { status: 400 });
  }
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const authKind = oauthClientId ? "oauth" : await detectAuthKind(url);
  const id = await upsertServer({
    scope: s, userId: null, projectId: s === "project" ? (projectId ?? null) : null, name, url, secrets, authKind,
  });
  await saveOAuthClientFromInput(id, oauthClientId, oauthClientSecret);
  await audit({ actorId: userId, action: "connector.add", targetType: "connector", targetKey: name, detail: { scope: s, authKind } });
  return Response.json({ ok: true, id, authKind });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  await setEnabled(id, enabled);
  await audit({ actorId: userId, action: enabled ? "connector.enable" : "connector.disable", targetType: "connector", targetKey: id });
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteServer(id);
  await audit({ actorId: userId, action: "connector.remove", targetType: "connector", targetKey: id });
  return Response.json({ ok: true });
});
