import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { resolveProviderConfig } from "./resolve";

/**
 * The model a chat should open with — a single, centralized precedence so every
 * entry point (existing chat, brand-new chat, empty landing) behaves the same:
 *
 *   1. the chat's own model        — an explicit choice sticks to the session
 *   2. its project's default model  — a deliberate per-project setting
 *   3. the user's last-used model   — most recent chat that has one (so a new
 *                                     chat opens with whatever you last picked)
 *   4. the provider config default  — the admin/shared fallback
 *
 * Returns "" only when nothing is configured at all.
 */
export async function resolveInitialModel(
  userId: string,
  opts: { chatModel?: string | null; projectDefaultModel?: string | null } = {},
): Promise<string> {
  if (opts.chatModel) return opts.chatModel;
  if (opts.projectDefaultModel) return opts.projectDefaultModel;

  const [lastUsed] = await db
    .select({ model: chats.model })
    .from(chats)
    .where(and(eq(chats.userId, userId), isNotNull(chats.model)))
    .orderBy(desc(chats.updatedAt))
    .limit(1);
  if (lastUsed?.model) return lastUsed.model;

  const config = await resolveProviderConfig(userId);
  return config?.defaultModel ? `${config.provider}:${config.defaultModel}` : "";
}
