import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiHandler, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { audit } from "@/lib/governance/audit";

/**
 * Admin config for the GitHub token used by every marketplace fetch/install.
 * Write-only, exactly like the Telegram OIDC secret: the value is encrypted at
 * rest and NEVER echoed back — the UI learns only whether one is stored. A token
 * lifts GitHub's 60-req/hour anonymous rate limit (the common cause of a failed
 * install) and unlocks private repos. This is why the token can't live in the
 * conversational `manage` tool: pasting it in chat would persist it in plaintext
 * in the message transcript, the very leak encryption-at-rest exists to prevent.
 */
export const GET = apiHandler(async () => {
  await requireAdmin();
  return Response.json({ configured: !!(await getSetting("github_token")) });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const { token } = z.object({ token: z.string().trim().min(1).max(255) }).parse(await req.json());
  await setSetting("github_token", token, true);
  await audit({ actorId: adminId, action: "settings.update", targetType: "settings", targetKey: "github_token", detail: { changed: true } });
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async () => {
  const { userId: adminId } = await requireAdmin();
  await db.delete(settings).where(eq(settings.key, "github_token"));
  await audit({ actorId: adminId, action: "settings.update", targetType: "settings", targetKey: "github_token", detail: { cleared: true } });
  return Response.json({ ok: true });
});
