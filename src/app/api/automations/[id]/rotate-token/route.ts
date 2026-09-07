import { and, eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations, automationWebhookDeliveries } from "@/lib/db/schema";
import { mintWebhookToken } from "@/lib/manage/controls/automations";
import type { AutomationTrigger } from "@/lib/automations/schedule";
import { getPublicUrl } from "@/lib/url";
import { audit } from "@/lib/governance/audit";

/**
 * Mint a new webhook URL for this automation and stop honoring the old one.
 *
 * There is no revoke-without-replace, because there is nothing to revoke: for a
 * webhook trigger the URL IS the credential, so "the address leaked" and "give me
 * a different address" are the same request. The old URL starts answering 404 the
 * moment this returns — whoever was calling it has to be handed the new one.
 *
 * Recorded as `automation.update` rather than a new audit action: it changes what
 * can run unattended, which is exactly what that action already means.
 */
export const POST = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireActive();
  const { id } = await params;
  const [row] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.userId, userId)));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  if ((row.trigger as AutomationTrigger).kind !== "webhook") {
    return Response.json({ error: "This automation is not triggered by a web address." }, { status: 400 });
  }

  const webhookToken = mintWebhookToken();
  await db.update(automations).set({ webhookToken, updatedAt: new Date() }).where(eq(automations.id, id));
  // The delivery keys were recorded against the address just retired; keeping
  // them would let a key the previous caller had already used swallow the new
  // caller's first delivery inside the 24h de-duplication window.
  await db.delete(automationWebhookDeliveries).where(eq(automationWebhookDeliveries.automationId, id));
  await audit({
    actorId: userId, action: "automation.update", targetType: "automation", targetKey: row.title,
    detail: { rotatedWebhookToken: true },
  });
  // The new URL comes straight back: the editor is a dialog sitting over the
  // list, and someone who has just retired an address needs the replacement to
  // copy right now — not after a reload that would close the dialog they are in.
  return Response.json({
    ok: true,
    webhookUrl: `${getPublicUrl({ headers: req.headers })}/api/hooks/automations/${webhookToken}`,
  });
});
