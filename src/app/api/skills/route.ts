import { and, eq } from "drizzle-orm";
import { apiHandler, requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { skills } from "@/lib/db/schema";
import { listAvailableSkills } from "@/lib/skills/service";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  const list = await listAvailableSkills(userId, null);
  return Response.json({
    skills: list.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      scope: s.scope,
      enabled: s.enabled,
    })),
  });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // A user may only toggle their own user-scope skills; system/project skills
  // are admin-managed.
  const res = await db
    .update(skills)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(skills.id, id), eq(skills.userId, userId), eq(skills.scope, "user")))
    .returning({ id: skills.id });
  if (res.length === 0) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  return Response.json({ ok: true });
});
