import { apiHandler, requireAdmin } from "@/lib/auth";
import { listPolicies, setPolicy, clearPolicy, listCapabilityInventory } from "@/lib/governance/policy";
import { audit } from "@/lib/governance/audit";
import type { CapabilityType, Effect } from "@/lib/governance/types";

const EFFECTS: Effect[] = ["allow", "deny", "ask"];
const TYPES: CapabilityType[] = ["skill", "connector"];

export const GET = apiHandler(async () => {
  await requireAdmin();
  const [policies, inventory] = await Promise.all([listPolicies(), listCapabilityInventory()]);
  return Response.json({ policies, inventory });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { capabilityType, capabilityKey, effect } = await req.json();
  if (!TYPES.includes(capabilityType) || typeof capabilityKey !== "string" || !EFFECTS.includes(effect)) {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const id = await setPolicy({ capabilityType, capabilityKey, effect, createdBy: userId });
  await audit({ actorId: userId, action: "policy.set", targetType: capabilityType, targetKey: capabilityKey, detail: { effect } });
  return Response.json({ ok: true, id });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await clearPolicy(id);
  await audit({ actorId: userId, action: "policy.clear", targetType: "policy", targetKey: id });
  return Response.json({ ok: true });
});
