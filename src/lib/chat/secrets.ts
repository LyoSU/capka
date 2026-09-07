import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { chatSecrets } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getMasterKey } from "@/lib/settings";
import { log } from "@/lib/log";

/**
 * Thread-scoped credentials the model never sees.
 *
 * The user hands the agent an API token or a password for ONE chat; it is stored
 * encrypted, injected into that chat's sandbox as an environment variable, and named
 * (never quoted) in the system prompt. Nothing here returns a plaintext value to the
 * web layer — `loadSecretEnv` is for the sandbox injection alone, and the redaction
 * below is what keeps a value that leaks into command output out of the transcript.
 */

/** Shell/env shape, and the ceiling a controller-side validator repeats. */
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_VALUE_CHARS = 8192;

/**
 * What the user typed, turned into an environment variable name: trimmed, upper-cased,
 * and every run of non-alphanumerics collapsed to a single `_`. Returns null when the
 * result cannot be a variable name at all — empty, over 64 characters, or starting with
 * something other than a letter ("1password" has no valid reading as `$1PASSWORD`).
 *
 * Normalising rather than rejecting is deliberate: the audience types "stripe key", not
 * `STRIPE_KEY`, and a form that refuses the former teaches nothing.
 */
export function normalizeSecretName(raw: string): string | null {
  const name = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return NAME_RE.test(name) ? name : null;
}

/** A value is storable when it is non-empty, within the cap, and carries no NUL —
 *  a NUL cannot survive an environment variable and would truncate it silently. */
export function isValidSecretValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_VALUE_CHARS && !value.includes("\0");
}

/**
 * Replace every occurrence of every secret value in `text` with `[secret:NAME]`.
 *
 * LONGEST FIRST, because one credential is often a prefix or a substring of another (a
 * token and the same token with a suffix): replacing the short one first would leave the
 * long one half-redacted, and half a credential in the transcript is still a leak.
 *
 * Values shorter than four characters are skipped — a two-character "password" would
 * match ordinary prose everywhere and turn the output into confetti, which the model then
 * cannot read at all. That is a deliberate trade: such a value protects nothing anyway.
 */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  if (!text) return text;
  const pairs = Object.entries(secrets)
    .filter(([, v]) => v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of pairs) out = out.split(value).join(`[secret:${name}]`);
  return out;
}

/** The names stored for this chat, oldest first. Names only — there is no path in
 *  this codebase that reads a value back out to the browser. */
export async function listSecretNames(chatId: string): Promise<{ name: string; createdAt: Date | null }[]> {
  const rows = await db
    .select({ name: chatSecrets.name, createdAt: chatSecrets.createdAt })
    .from(chatSecrets)
    .where(eq(chatSecrets.chatId, chatId))
    .orderBy(asc(chatSecrets.createdAt), asc(chatSecrets.name));
  return rows;
}

/** Store (or replace) one credential. Re-saving a name overwrites it — the unique
 *  index on (chat_id, name) is the upsert target, so a chat can never hold two values
 *  for one variable and leave the injection to pick. */
export async function setSecret(input: { chatId: string; userId: string; name: string; value: string }): Promise<void> {
  const valueEnc = encrypt(input.value, await getMasterKey());
  await db
    .insert(chatSecrets)
    .values({ id: nanoid(), chatId: input.chatId, userId: input.userId, name: input.name, valueEnc })
    .onConflictDoUpdate({
      target: [chatSecrets.chatId, chatSecrets.name],
      set: { valueEnc, userId: input.userId, createdAt: new Date() },
    });
}

/** The inverse of `setSecret`, and the only way a secret is removed — the module that
 *  registers a thing owns undoing it (see AGENTS.md). */
export async function deleteSecret(chatId: string, name: string): Promise<void> {
  await db.delete(chatSecrets).where(and(eq(chatSecrets.chatId, chatId), eq(chatSecrets.name, name)));
}

/**
 * The decrypted environment for this chat's sandbox commands. `{}` when the chat has
 * none, which is the overwhelmingly common case.
 *
 * A row that fails to decrypt is LOGGED AND SKIPPED, never thrown: a master key rotated
 * out from under one stale row must not take down every turn in the chat, and the model
 * gets a clear failure from the command that needed the variable instead of an opaque
 * dead conversation.
 */
export async function loadSecretEnv(chatId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ name: chatSecrets.name, valueEnc: chatSecrets.valueEnc })
    .from(chatSecrets)
    .where(eq(chatSecrets.chatId, chatId));
  if (rows.length === 0) return {};
  const key = await getMasterKey();
  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      env[row.name] = decrypt(row.valueEnc, key);
    } catch {
      // No value, no name-plus-value pairing, nothing that narrows the ciphertext.
      log.warn("chat secret could not be decrypted; skipping", { chatId, name: row.name });
    }
  }
  return env;
}
