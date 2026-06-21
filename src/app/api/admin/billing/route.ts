import { eq } from "drizzle-orm";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { tiers, users } from "@/lib/db/schema";
import { getProviderKeyMode, setSetting, type ProviderKeyMode } from "@/lib/settings";
import { getDefaultTier } from "@/lib/billing/limits";

const MODES: ProviderKeyMode[] = ["shared_plus_own", "shared_only", "own_only"];

// Normalize a money field from the client: "" / null → null (unlimited),
// otherwise a non-negative number as a string for the numeric column.
function parseCap(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(n);
}

export const GET = apiHandler(async () => {
  await requireAdmin();

  const [keyMode, defaultTier, allTiers, userRows] = await Promise.all([
    getProviderKeyMode(),
    getDefaultTier(),
    db.select().from(tiers).orderBy(tiers.createdAt),
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, tierId: users.tierId })
      .from(users)
      .orderBy(users.createdAt),
  ]);

  return Response.json({ keyMode, defaultTier, tiers: allTiers, users: userRows });
});

/**
 * Single endpoint for every admin billing mutation, keyed by `action`:
 *  - setMode:    change the instance provider-key mode
 *  - setLimits:  set the default tier's 5h / week / month caps
 *  - assignTier: hand-assign a user to a tier (scaffold for future auto/api)
 */
export const PUT = apiHandler(async (req: Request) => {
  await requireAdmin();
  const body = await req.json();
  const action = body?.action;

  if (action === "setMode") {
    if (!MODES.includes(body.mode)) {
      return Response.json({ error: "Invalid mode" }, { status: 400 });
    }
    await setSetting("provider_key_mode", body.mode);
    // Keep the legacy boolean consistent so any old reader stays correct.
    await setSetting("share_admin_providers", body.mode === "own_only" ? "false" : "true");
    return Response.json({ ok: true, keyMode: body.mode });
  }

  if (action === "setLimits") {
    const tier = await getDefaultTier();
    const [updated] = await db
      .update(tiers)
      .set({
        limit5h: parseCap(body.limit5h),
        limitWeek: parseCap(body.limitWeek),
        limitMonth: parseCap(body.limitMonth),
      })
      .where(eq(tiers.id, tier.id))
      .returning();
    return Response.json({ ok: true, defaultTier: updated });
  }

  if (action === "assignTier") {
    if (!body.userId) return Response.json({ error: "Missing userId" }, { status: 400 });
    // null clears the override → user falls back to the default tier.
    const tierId = body.tierId || null;
    if (tierId) {
      const [t] = await db.select({ id: tiers.id }).from(tiers).where(eq(tiers.id, tierId)).limit(1);
      if (!t) return Response.json({ error: "Tier not found" }, { status: 404 });
    }
    const [updated] = await db
      .update(users)
      .set({ tierId, tierSource: "manual" })
      .where(eq(users.id, body.userId))
      .returning({ id: users.id, tierId: users.tierId });
    if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
    return Response.json({ ok: true, user: updated });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
});
