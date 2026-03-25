import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getMasterKey } from "@/lib/settings";

export async function GET() {
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
}

export async function POST(req: Request) {
  const { userId } = await requireRole("admin", "user");

  const { provider, apiKey, baseUrl, defaultModel } = await req.json();
  if (!provider) {
    return Response.json({ error: "Missing provider" }, { status: 400 });
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

  return Response.json({ id, provider, defaultModel, isActive: true });
}

export async function DELETE(req: Request) {
  const { userId } = await requireRole("admin", "user");

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await db
    .delete(providerConfigs)
    .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)));

  return Response.json({ ok: true });
}
