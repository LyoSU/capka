import { apiHandler, requireAdmin } from "@/lib/auth";
import { listPolicies, setPolicy, clearPolicy, listCapabilityInventory, listProjectsForPolicy } from "@/lib/governance/policy";
import { audit } from "@/lib/governance/audit";
import type { CapabilityType, Effect, PolicyScope } from "@/lib/governance/types";

const EFFECTS: Effect[] = ["allow", "deny", "ask"];
const TYPES: CapabilityType[] = ["skill", "connector"];
const SCOPES: PolicyScope[] = ["system", "user", "project"];

export const GET = apiHandler(async () => {
  await requireAdmin();
  const [policies, inventory, projects] = await Promise.all([listPolicies(), listCapabilityInventory(), listProjectsForPolicy()]);
  return Response.json({ policies, inventory, projects });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const { capabilityType, capabilityKey, effect, scope = "system", userId, projectId } = await req.json();
  if (!TYPES.includes(capabilityType) || typeof capabilityKey !== "string" || !capabilityKey.trim() || !EFFECTS.includes(effect) || !SCOPES.includes(scope)) {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // The subject must match the scope, mirroring the DB CHECK constraint: system
  // carries no subject, user needs a userId, project needs a projectId.
  if (scope === "system" && (userId != null || projectId != null)) return Response.json({ error: "System scope takes no subject" }, { status: 400 });
  if (scope === "user" && (typeof userId !== "string" || projectId != null)) return Response.json({ error: "User scope needs a userId" }, { status: 400 });
  if (scope === "project" && (typeof projectId !== "string" || userId != null)) return Response.json({ error: "Project scope needs a projectId" }, { status: 400 });

  const id = await setPolicy({ capabilityType, capabilityKey, effect, scope, userId, projectId, createdBy: adminId });
  await audit({ actorId: adminId, action: "policy.set", targetType: capabilityType, targetKey: capabilityKey, detail: { effect, scope, userId: userId ?? null, projectId: projectId ?? null } });
  return Response.json({ ok: true, id });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  // Read-through delete: the returned row is the only record of what the policy
  // governed, so the audit trail stays reconstructable after removal.
  const removed = await clearPolicy(id);
  if (!removed) return Response.json({ error: "Not found" }, { status: 404 });
  await audit({
    actorId: adminId, action: "policy.clear",
    targetType: removed.capabilityType, targetKey: removed.capabilityKey,
    detail: { scope: removed.scope, effect: removed.effect, userId: removed.userId, projectId: removed.projectId },
  });
  return Response.json({ ok: true });
});
