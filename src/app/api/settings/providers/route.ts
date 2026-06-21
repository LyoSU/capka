import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getMasterKey, ownKeysAllowed } from "@/lib/settings";
import { ForbiddenError } from "@/lib/errors";
import { PROVIDERS } from "@/lib/providers";
import { invalidateModelsCache } from "@/lib/providers/list-models";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();

  const rows = await db
    .select({
      id: providerConfigs.id,
      provider: providerConfigs.provider,
      baseUrl: providerConfigs.baseUrl,
      defaultModel: providerConfigs.defaultModel,
      isActive: providerConfigs.isActive,
      createdAt: providerConfigs.createdAt,
    })
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, userId));

  return Response.json(rows);
});

export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireRole("admin", "user");

  // In shared_only, regular users may not add their own key — the admin's shared
  // key is the only one. Admins always may (they configure that shared key here).
  if (role !== "admin" && !(await ownKeysAllowed())) {
    throw new ForbiddenError("Adding your own provider key is disabled on this instance.");
  }

  const { provider, apiKey, baseUrl, defaultModel } = await req.json();
  if (!provider || !PROVIDERS.includes(provider)) {
    return Response.json({ error: "Invalid or missing provider" }, { status: 400 });
  }

  const masterKey = await getMasterKey();
  const encryptedKey = apiKey ? encrypt(apiKey, masterKey) : null;

  // Deactivate existing configs for this user
  await db
    .update(providerConfigs)
    .set({ isActive: false })
    .where(eq(providerConfigs.userId, userId));

  const id = nanoid();
  await db.insert(providerConfigs).values({
    id,
    userId,
    provider,
    apiKey: encryptedKey,
    baseUrl: baseUrl || null,
    defaultModel: defaultModel || null,
    isActive: true,
  });

  invalidateModelsCache();
  return Response.json({ id, provider, defaultModel, isActive: true });
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { id, defaultModel, activate } = await req.json();
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  if (activate) {
    await db.update(providerConfigs).set({ isActive: false }).where(eq(providerConfigs.userId, userId));
    const [updated] = await db
      .update(providerConfigs)
      .set({ isActive: true })
      .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)))
      .returning();
    if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
    invalidateModelsCache();
    return Response.json({ id: updated.id, isActive: true });
  }

  const [updated] = await db
    .update(providerConfigs)
    .set({ defaultModel: defaultModel || null })
    .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)))
    .returning();

  if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
  invalidateModelsCache();
  return Response.json({ id: updated.id, defaultModel: updated.defaultModel });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await db
    .delete(providerConfigs)
    .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)));

  invalidateModelsCache();
  return Response.json({ ok: true });
});
