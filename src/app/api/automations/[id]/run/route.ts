import { and, eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { fireAutomation } from "@/lib/automations/runs";
import { audit } from "@/lib/governance/audit";

/**
 * Run an automation once, now, without touching its schedule.
 *
 * The point is being able to TEST one: a monthly report otherwise takes a month
 * to find out whether its instruction says what the user meant. Paused
 * automations can be run too — checking the fix is exactly what someone does
 * before switching a failing one back on.
 *
 * `next_run_at` is deliberately untouched — this is an extra run, not a
 * rescheduling — and the overlap guard inside fireAutomation still applies, so a
 * run started while the previous one is live is refused rather than queued.
 *
 * The daily run limit and the `run_when` condition are BYPASSED here on purpose
 * (`manual: true`). Both exist to police UNATTENDED runs; a person is standing in
 * front of this one, and it is the run someone makes to check a fix. A cap that
 * blocked it would make a capped automation impossible to debug on the day it hit
 * its ceiling, and a condition that blocked it would leave "my condition is
 * wrong" and "my instruction is wrong" impossible to tell apart.
 */
export const POST = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireActive();
  const { id } = await params;
  const [row] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.userId, userId)));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  const { fired, chatId } = await fireAutomation(row, { manual: true });
  // A skip is not a failure: the previous run is still working (or waiting on an
  // answer). Say which, so the UI can explain instead of showing an error.
  if (!fired) return Response.json({ ok: false, reason: "busy" }, { status: 409 });

  await audit({ actorId: userId, action: "automation.run", targetType: "automation", targetKey: row.title });
  return Response.json({ ok: true, chatId });
});
