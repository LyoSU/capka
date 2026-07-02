import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { buildRegistry } from "./controls";
import { applyPending } from "./dispatch";
import type { ManageResult } from "./types";

/**
 * The ONE canonical human-authed apply path — resolve a user's role + locale and
 * apply a staged pending AS them. Both channels that a human confirms through
 * (the web `/api/manage/confirm` endpoint and the Telegram `mc:` callback) go
 * through here, so the identity that authorizes a confirm is built one way and
 * can't quietly diverge between channels. The model never reaches this — only a
 * real session cookie / verified Telegram link resolves to a `userId`.
 */
export async function applyPendingForUser(userId: string, pendingId: string): Promise<ManageResult> {
  const [u] = await db.select({ role: users.role, locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
  return applyPending(buildRegistry(), {
    userId,
    isAdmin: u?.role === "admin",
    projectId: null,
    locale: u?.locale ?? undefined,
  }, pendingId);
}
