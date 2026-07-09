import { apiHandler, requireAdmin } from "@/lib/auth";
import { upsertServer, upsertStdioServer, setEnabled, deleteServer, getServerMeta, projectExists } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { saveOAuthClientFromInput } from "@/lib/mcp/oauth/admin-client";
import { audit } from "@/lib/governance/audit";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const rl = take(`admin-mcp:${userId}`);
  if (!rl.ok) return Response.json({ error: "Too many requests — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  const body = await req.json();
  const { name, url, headers, scope, projectId, oauthClientId, oauthClientSecret, command, args, env, authKind: pick } = body;
  const s = scope === "project" ? "project" : "system";
  // A project-scoped connector carries secret headers/env; never attach it to a
  // projectId the request invented — verify the project exists first.
  if (s === "project") {
    if (typeof projectId !== "string" || !projectId.trim()) return Response.json({ error: "projectId required" }, { status: 400 });
    if (!(await projectExists(projectId))) return Response.json({ error: "Unknown project" }, { status: 404 });
  }

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
  // Explicit method from the form wins; pre-registered client forces OAuth; else probe.
  const authKind =
    oauthClientId ? "oauth" : pick === "oauth" || pick === "token" ? pick : await detectAuthKind(url);
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
  // This route manages shared (system/project) connectors only; a member's
  // PERSONAL (user-scope) connector is owner-managed via /api/mcp.
  const meta = await getServerMeta(id);
  if (!meta || meta.scope === "user") return Response.json({ error: "Not found" }, { status: 404 });
  await setEnabled(id, enabled);
  await audit({ actorId: userId, action: enabled ? "connector.enable" : "connector.disable", targetType: "connector", targetKey: id, detail: { name: meta.name } });
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const meta = await getServerMeta(id);
  if (!meta || meta.scope === "user") return Response.json({ error: "Not found" }, { status: 404 });
  await deleteServer(id);
  await audit({ actorId: userId, action: "connector.remove", targetType: "connector", targetKey: id, detail: { name: meta.name } });
  return Response.json({ ok: true });
});
