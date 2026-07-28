import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireActive, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { parseAgentProfile } from "@/lib/agents/profile";
import { getOrgAgentProfile } from "@/lib/settings";

/**
 * The caller's OWN agent profile — the third layer folded under the org ceiling
 * and a project's profile (see run-context.ts).
 *
 * Open to any active user, admin or not, and safe to be: the fold is a minimum,
 * so anything written here can only take capabilities away from the writer's own
 * chats. There is no shape a user could post that grants them something an admin
 * disabled, which is why this needs no ROLE check — only `requireActive`, so a
 * pending/suspended account can neither write here nor read the org ceiling back
 * out (self-scoped preferences use requireActive; see lib/auth.ts).
 */

/** The caller's own profile plus the org ceiling clamping it. The ceiling ships
 *  alongside so the UI can show a switch as locked instead of letting someone turn
 *  something on that the fold will discard — the same honesty rule the project-level
 *  section follows. It reveals only the policy already applied to this user. */
export const GET = apiHandler(async () => {
  const { userId } = await requireActive();
  const [[row], ceiling] = await Promise.all([
    db.select({ agentProfile: users.agentProfile }).from(users).where(eq(users.id, userId)).limit(1),
    getOrgAgentProfile(),
  ]);
  return Response.json({ profile: parseAgentProfile(row?.agentProfile), ceiling });
});

/**
 * Only the fields a user is actually offered, merged over what's stored — NOT the
 * whole profile schema.
 *
 * The fold's no-grant invariant would hold either way, so this isn't about
 * privilege. It's that `replace`/`sessionContext:false`/every capability bit are
 * the RESTRICTIVE side of the fold, so accepting them here would let a hand-rolled
 * request strip a user's own agent down to nothing — silently, permanently, and
 * beyond any admin setting's power to put back. Memory is the one switch the UI
 * exposes (see settings/memory), so memory is the one field that may be written.
 */
const patchSchema = z.object({ capabilities: z.object({ memory: z.boolean() }) });

export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const patch = patchSchema.parse(await req.json());

  const [row] = await db
    .select({ agentProfile: users.agentProfile })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const current = parseAgentProfile(row?.agentProfile);
  const profile = {
    ...current,
    capabilities: { ...current.capabilities, memory: patch.capabilities.memory },
  };

  await db.update(users).set({ agentProfile: profile }).where(eq(users.id, userId));
  return Response.json(profile);
});
