import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";

/**
 * Resolve a user's active provider config into an AI SDK model instance.
 * Handles DB lookup, key decryption, and model resolution.
 */
export async function resolveUserModel(userId: string, requestModel?: string) {
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) throw new Error("No LLM provider configured. Set one up in Settings.");
  if (!config.defaultModel) throw new Error("No default model set. Configure one in Settings → Connections.");

  let apiKey = config.apiKey;
  if (apiKey) {
    const mk = await getMasterKey();
    apiKey = decrypt(apiKey, mk);
  }

  let provider = config.provider;
  let modelId = config.defaultModel;

  if (requestModel?.includes(":")) {
    const [p, ...rest] = requestModel.split(":");
    provider = p;
    modelId = rest.join(":");
  } else if (requestModel) {
    modelId = requestModel;
  }

  return getModel(provider, modelId, {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });
}
