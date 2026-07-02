import { and, eq } from "drizzle-orm";
import { apiHandler, requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { nextOccurrenceAfter, type AutomationTrigger } from "@/lib/automations/schedule";

export const PATCH = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const { enabled } = await req.json();
  const [row] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.userId, userId)));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  await db.update(automations).set({
    enabled: Boolean(enabled),
    ...(enabled ? { nextRunAt: nextOccurrenceAfter(row.trigger as AutomationTrigger, new Date()), consecutiveFailures: 0 } : {}),
    updatedAt: new Date(),
  }).where(eq(automations.id, id));
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const res = await db.delete(automations).where(and(eq(automations.id, id), eq(automations.userId, userId))).returning({ id: automations.id });
  if (!res.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
});
