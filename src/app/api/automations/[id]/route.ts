import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { nextOccurrenceAfter, type AutomationTrigger } from "@/lib/automations/schedule";

const patchBody = z.object({ enabled: z.boolean() });

export const PATCH = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  // Enable/disable resumes or pauses unattended budget spend — active accounts only.
  const { userId } = await requireActive();
  const { id } = await params;
  // Strict boolean: a lenient Boolean(enabled) would turn the string "false" into
  // true and silently RE-enable an automation the user meant to pause.
  const parsed = patchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  const { enabled } = parsed.data;
  const [row] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.userId, userId)));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  await db.update(automations).set({
    enabled,
    ...(enabled ? { nextRunAt: nextOccurrenceAfter(row.trigger as AutomationTrigger, new Date()), consecutiveFailures: 0 } : {}),
    updatedAt: new Date(),
  }).where(eq(automations.id, id));
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireActive();
  const { id } = await params;
  const res = await db.delete(automations).where(and(eq(automations.id, id), eq(automations.userId, userId))).returning({ id: automations.id });
  if (!res.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
});
