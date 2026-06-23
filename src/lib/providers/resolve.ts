import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs, users } from "@/lib/db/schema";
import { getMasterKey, sharedKeyEnabled, getModelMaxPrice } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel, parseModelId, splitModelRef, providerLabel, isProviderName } from "@/lib/providers";
import { assertSafeProviderConfig, getModelCompletionPriceUsdPerM, getModelInputModalities } from "@/lib/providers/list-models";
import { ValidationError } from "@/lib/errors";

type ProviderConfigRow = typeof providerConfigs.$inferSelect;

/**
 * Every provider config the user can draw on, newest first. Several may be
 * enabled at once, so the picker can show models from all of them and the chat
 * can route to whichever a model belongs to. Own configs win outright; only a
 * user with none falls back to an admin's shared configs (and thus their budget
 * + sandbox), and only when the instance mode permits a shared key — never in
 * own_only, so a stray account can't silently spend the admin's credits.
 */
export async function resolveEnabledConfigs(
  userId: string,
): Promise<(ProviderConfigRow & { isShared: boolean })[]> {
  const own = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .orderBy(providerConfigs.createdAt);
  if (own.length) return own.map((c) => ({ ...c, isShared: false }));

  if (!(await sharedKeyEnabled())) return [];

  const rows = await db
    .select({ config: providerConfigs })
    .from(providerConfigs)
    .innerJoin(users, eq(providerConfigs.userId, users.id))
    // Only admin keys explicitly marked shared enter the pool — a private admin
    // key (shared=false) is theirs alone.
    .where(and(eq(users.role, "admin"), eq(providerConfigs.isActive, true), eq(providerConfigs.shared, true)))
    .orderBy(providerConfigs.createdAt);
  return rows.map((r) => ({ ...r.config, isShared: true }));
}

/**
 * A human label per enabled config, for the picker's per-row source badge. A
 * provider with a single config just shows its label ("OpenRouter"); when two
 * configs share a provider (e.g. two LiteLLM proxies) they're disambiguated by
 * endpoint host, falling back to a stable ordinal so they're never identical.
 */
export function labelEnabledConfigs(
  configs: { id: string; provider: string; baseUrl: string | null; label?: string | null }[],
): Map<string, string> {
  const count = new Map<string, number>();
  for (const c of configs) count.set(c.provider, (count.get(c.provider) ?? 0) + 1);

  const ordinal = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of configs) {
    // A user-given name always wins — that's the whole point of letting them
    // name a connection.
    if (c.label?.trim()) {
      out.set(c.id, c.label.trim());
      continue;
    }
    const base = providerLabel(c.provider);
    if ((count.get(c.provider) ?? 0) <= 1) {
      out.set(c.id, base);
      continue;
    }
    let suffix = "";
    if (c.baseUrl) {
      try { suffix = new URL(c.baseUrl).host; } catch { /* not a URL — fall through */ }
    }
    if (!suffix) {
      const n = (ordinal.get(c.provider) ?? 0) + 1;
      ordinal.set(c.provider, n);
      suffix = `#${n}`;
    }
    out.set(c.id, `${base} · ${suffix}`);
  }
  return out;
}

/**
 * The default config when no specific model is requested (brand-new chat, or a
 * legacy bare-id value): the user's first enabled config, else an admin's.
 */
export async function resolveProviderConfig(userId: string) {
  const [first] = await resolveEnabledConfigs(userId);
  return first ?? null;
}

/**
 * Load a single config by id — own first, then (when sharing is on) an admin's,
 * so a shared-key user's ref that names the admin's config still resolves.
 * Returns null when the id names no reachable config.
 */
export async function resolveConfigById(userId: string, configId: string) {
  const [own] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.id, configId), eq(providerConfigs.userId, userId)))
    .limit(1);
  if (own) return { ...own, isShared: false };

  if (!(await sharedKeyEnabled())) return null;

  const [shared] = await db
    .select({ config: providerConfigs })
    .from(providerConfigs)
    .innerJoin(users, eq(providerConfigs.userId, users.id))
    // A user can only resolve a model ref to an admin key that's actually shared.
    .where(and(eq(providerConfigs.id, configId), eq(users.role, "admin"), eq(providerConfigs.shared, true)))
    .limit(1);
  return shared ? { ...shared.config, isShared: true } : null;
}

/**
 * Resolve a user's model along with the provider/model identifiers, so callers
 * that need to record usage/cost (the worker) don't have to re-derive them.
 */
export async function resolveUserModelInfo(userId: string, requestModel?: string) {
  // Pick the config + bare model id this request targets:
  //   1. `${configId}:${modelId}` ref → the named config (the normal path now
  //      that the picker tags every model with its owning config);
  //   2. legacy `provider:modelId` / bare id, or no model at all → the default
  //      config, taking the model from the value (if any) or its own default.
  let config: Awaited<ReturnType<typeof resolveConfigById>> = null;
  let modelId: string | undefined;

  if (requestModel) {
    const { configId, modelId: rest } = splitModelRef(requestModel);
    if (configId) {
      const byId = await resolveConfigById(userId, configId);
      if (byId) {
        config = byId;
        modelId = rest;
      } else if (!isProviderName(configId)) {
        // The ref named a specific connection (a configId), but it no longer
        // exists — the provider was disconnected or removed. Refuse instead of
        // silently falling back to a different connection that can't serve this
        // model (the turn would just fail in the background). The client blocks
        // the composer for the same reason; this is the server-side backstop. A
        // legacy `provider:modelId` value (configId is a known provider name)
        // still falls through to the default-config path below.
        throw new ValidationError(
          "This chat's model is no longer available — its connection was removed. Please choose another model.",
        );
      }
    }
  }

  if (!config) {
    config = await resolveProviderConfig(userId);
    if (!config) throw new ValidationError("No LLM provider configured. Ask your admin to set one up.");
    // Legacy value: keep just the model id (provider can't switch the config by
    // name once several exist — best-effort onto the default config).
    modelId = requestModel ? parseModelId(requestModel, config.provider).modelId : (config.defaultModel ?? undefined);
  }

  if (!modelId) throw new ValidationError("No default model set. Configure one in Settings → Connections.");

  // Budget guard: when spending a SHARED (admin) key, the admin's max-price cap
  // is enforced here too — not just hidden in the picker — so a stale or
  // hand-set expensive model can't slip through. Unknown price (a generic
  // gateway) isn't comparable, so it passes. Own/owner keys are never capped.
  if (config.isShared) {
    const maxPrice = await getModelMaxPrice();
    if (maxPrice > 0) {
      const price = await getModelCompletionPriceUsdPerM(modelId);
      if (price > maxPrice) {
        throw new ValidationError(
          "This model costs more than your administrator allows on the shared key. Please choose a less expensive one.",
        );
      }
    }
  }

  let apiKey = config.apiKey;
  if (apiKey) {
    const mk = await getMasterKey();
    apiKey = decrypt(apiKey, mk);
  }

  // SSRF guard on the real inference path — same policy as listing/testing.
  await assertSafeProviderConfig(config.provider, config.baseUrl);

  const model = getModel(config.provider, modelId, {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });
  // Per-model native input modalities from the synced catalog: OpenRouter's
  // `architecture.input_modalities` and LiteLLM's `supported_modalities` +
  // `supports_*_input` flags, both parsed into the same shape. Used for ANY
  // provider the catalog knows (direct OpenAI/Anthropic/Gemini are covered by the
  // LiteLLM price book, matched by id); unknown models fall back to the provider's
  // static caps. `acceptsNativeFile` still hard-gates by SDK transport reality
  // (video → Google only, etc.), and the runner soft-retries without the file if a
  // provider rejects a modality it claimed — so trusting the metadata never turns
  // into a hard failure for the user.
  const modelInput = await getModelInputModalities(modelId, config.provider);
  return { model, provider: config.provider, modelId, modelInput, isShared: config.isShared };
}

export async function resolveUserModel(userId: string, requestModel?: string) {
  const { model } = await resolveUserModelInfo(userId, requestModel);
  return model;
}
