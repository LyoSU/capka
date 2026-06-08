import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs, users } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel, parseModelId } from "@/lib/providers";
import { ValidationError } from "@/lib/errors";

/** Find active provider config: user's own → fallback to any admin's config. */
export async function resolveProviderConfig(userId: string) {
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (config) return { ...config, isShared: false };

  const rows = await db
    .select({ config: providerConfigs })
    .from(providerConfigs)
    .innerJoin(users, eq(providerConfigs.userId, users.id))
    .where(and(eq(users.role, "admin"), eq(providerConfigs.isActive, true)))
    .orderBy(providerConfigs.createdAt)
    .limit(1);
  const fallback = rows[0]?.config;
  return fallback ? { ...fallback, isShared: true } : null;
}

/**
 * Resolve a user's model along with the provider/model identifiers, so callers
 * that need to record usage/cost (the worker) don't have to re-derive them.
 */
export async function resolveUserModelInfo(userId: string, requestModel?: string) {
  const config = await resolveProviderConfig(userId);
  if (!config) throw new ValidationError("No LLM provider configured. Ask your admin to set one up.");
  if (!config.defaultModel) throw new ValidationError("No default model set. Configure one in Settings → Connections.");

  let apiKey = config.apiKey;
  if (apiKey) {
    const mk = await getMasterKey();
    apiKey = decrypt(apiKey, mk);
  }

  let provider = config.provider;
  let modelId = config.defaultModel;

  if (requestModel) {
    const parsed = parseModelId(requestModel, provider);
    provider = parsed.provider ?? provider;
    modelId = parsed.modelId;
  }

  const model = getModel(provider, modelId, {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });
  return { model, provider, modelId };
}

export async function resolveUserModel(userId: string, requestModel?: string) {
  const { model } = await resolveUserModelInfo(userId, requestModel);
  return model;
}
