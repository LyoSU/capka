/**
 * The short, curated model list the Telegram `/model` command offers. There's no
 * room (or sense) in a chat bot for the full several-hundred-model catalog, so we
 * surface what's actually relevant: the models the user recently used, then each
 * provider config's default. Each is tagged with the media it can take (🖼 📄 🎧
 * 🎬) so a user picking a model for a voice note can see at a glance which ones
 * actually hear audio — the whole point of the picker.
 */
import { and, eq, desc, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs, chats } from "@/lib/db/schema";
import {
  splitModelRef,
  encodeModelRef,
  isProviderName,
  PROVIDER_META,
  type Modality,
} from "@/lib/providers/registry";
import { prettyName } from "@/lib/models/normalize";
import { getModelInputModalities } from "@/lib/providers/list-models";

const MODALITY_ICON: Record<Modality, string> = { image: "🖼", pdf: "📄", audio: "🎧", video: "🎬" };
const MAX_CHOICES = 8;

export interface ModelChoice {
  /** Config-scoped ref to store on the chat (`configId:modelId`). */
  ref: string;
  /** Button text: pretty model name + capability icons. */
  label: string;
}

/** The native input modalities a model accepts — the same precedence
 *  `acceptsNativeFile` uses, so the icons never disagree with what actually gets
 *  injected: OpenRouter's per-model catalog data first, else the provider's
 *  static caps. */
async function modalitiesFor(provider: string, modelId: string): Promise<Modality[]> {
  if (provider === "openrouter") {
    const mods = await getModelInputModalities(modelId);
    if (mods?.length) return mods;
  }
  return isProviderName(provider) ? PROVIDER_META[provider].nativeInput : [];
}

/**
 * Build the `/model` options for a user: recently-used models first (deduped,
 * newest first), then each provider config's default model, capped at
 * MAX_CHOICES. Deterministic, so a callback can rebuild the same list and index
 * into it by position (callback_data stays tiny and never hits Telegram's 64-byte
 * cap on long refs).
 */
export async function modelChoices(userId: string): Promise<ModelChoice[]> {
  const configs = await db
    .select({ id: providerConfigs.id, provider: providerConfigs.provider, defaultModel: providerConfigs.defaultModel })
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, userId));
  const providerByConfig = new Map(configs.map((c) => [c.id, c.provider]));

  const recent = await db
    .select({ model: chats.model })
    .from(chats)
    .where(and(eq(chats.userId, userId), isNotNull(chats.model)))
    .orderBy(desc(chats.updatedAt))
    .limit(20);

  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (ref: string | null | undefined) => {
    if (ref && !seen.has(ref)) { seen.add(ref); refs.push(ref); }
  };
  for (const r of recent) add(r.model);
  for (const c of configs) if (c.defaultModel) add(encodeModelRef(c.id, c.defaultModel));

  const choices: ModelChoice[] = [];
  for (const ref of refs.slice(0, MAX_CHOICES)) {
    const { configId, modelId } = splitModelRef(ref);
    const provider = configId ? providerByConfig.get(configId) : undefined;
    const mods = provider ? await modalitiesFor(provider, modelId) : [];
    const icons = mods.map((m) => MODALITY_ICON[m]).join("");
    choices.push({ ref, label: icons ? `${prettyName(modelId)} ${icons}` : prettyName(modelId) });
  }
  return choices;
}
