import { apiHandler, requireAdmin } from "@/lib/auth";
import { upsertServer, setEnabled, deleteServer } from "@/lib/mcp/service";

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { name, url, headers, scope, projectId } = await req.json();
  if (typeof name !== "string" || typeof url !== "string") {
    return Response.json({ error: "name and url required" }, { status: 400 });
  }
  const s = scope === "project" ? "project" : "system";
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const id = await upsertServer({
    scope: s, userId: null, projectId: s === "project" ? (projectId ?? null) : null, name, url, secrets,
  });
  return Response.json({ ok: true, id });
});

export const PATCH = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  await setEnabled(id, enabled);
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteServer(id);
  return Response.json({ ok: true });
});
