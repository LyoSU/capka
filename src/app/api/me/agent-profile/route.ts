import { eq } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { agentProfileSchema, parseAgentProfile } from "@/lib/agents/profile";
import { getOrgAgentProfile } from "@/lib/settings";

/**
 * The caller's OWN agent profile — the third layer folded under the org ceiling
 * and a project's profile (see run-context.ts).
 *
 * Open to any signed-in user, and safe to be: the fold is a minimum, so anything
 * written here can only take capabilities away from the writer's own chats. There
 * is no shape a user could post that grants them something an admin disabled,
 * which is why this needs no role check beyond "is this you".
 */
/** The caller's own profile plus the org ceiling clamping it. The ceiling ships
 *  alongside so the UI can show a switch as locked instead of letting someone turn
 *  something on that the fold will discard — the same honesty rule the project-level
 *  section follows. It reveals only the policy already applied to this user. */
export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  const [[row], ceiling] = await Promise.all([
    db.select({ agentProfile: users.agentProfile }).from(users).where(eq(users.id, userId)).limit(1),
    getOrgAgentProfile(),
  ]);
  return Response.json({ profile: parseAgentProfile(row?.agentProfile), ceiling });
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const profile = agentProfileSchema.parse(await req.json());
  await db.update(users).set({ agentProfile: profile }).where(eq(users.id, userId));
  return Response.json(profile);
});
