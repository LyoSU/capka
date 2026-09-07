import { and, asc, eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { chatSecrets, chats } from "@/lib/db/schema";
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
 * The redactor's floor, and therefore the storage floor too.
 *
 * A value this short matches ordinary prose everywhere, so redacting it would shred the
 * output the model has to read. The redactor has always skipped such values; the API used
 * to accept them anyway, which stored a credential under a promise ("the model never sees
 * it") that nothing upstream kept. ONE constant, read by both the validator and the
 * redactor, is what makes the two ends agree — a floor enforced on only one side is the
 * hole, not the trade-off.
 */
export const MIN_SECRET_VALUE_CHARS = 4;

/**
 * How many credentials one chat may store.
 *
 * The sandbox controller refuses an exec whose `env` carries more than 32 entries
 * (`sandbox-controller/server.js`), and the platform adds NOTHING to that object — it
 * sends this chat's secrets and only those (see `execCommand` in `src/lib/sandbox/client.ts`
 * and `loadSandboxTools`). So the whole controller budget belongs to secrets, and the cap
 * is that budget exactly. Anyone who later puts a platform-owned variable on that exec
 * must lower this by the same count: without the web-side cap the 33rd secret turned every
 * command in the chat into an HTTP 400 until someone deleted a row.
 */
export const MAX_CHAT_SECRETS = 32;

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

/** A value is storable when it clears the redactor's floor, stays within the cap, and
 *  carries no NUL — a NUL cannot survive an environment variable and would truncate it
 *  silently. The floor is `MIN_SECRET_VALUE_CHARS`, shared with `redactSecrets`. */
export function isValidSecretValue(value: string): boolean {
  return (
    value.length >= MIN_SECRET_VALUE_CHARS &&
    value.length <= MAX_SECRET_VALUE_CHARS &&
    !value.includes("\0")
  );
}

/**
 * Every spelling of one value that the model could read back out as the value itself:
 * the literal, its base64 (standard and url-safe, padded and not), its hex in both
 * cases, and its percent-encoding when that differs. Encodings are of the UTF-8 bytes,
 * which is what any tool in the sandbox would encode.
 *
 * This list exists because `printf %s "$KEY" | base64` was a complete bypass of the
 * literal-only redactor: the model decodes it itself, so the transcript held the
 * credential in a form only a human reader would call redacted.
 */
function secretForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const b64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  return [
    value,
    b64,
    b64.replace(/=+$/, ""),
    b64.replace(/\+/g, "-").replace(/\//g, "_"),
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    hex,
    hex.toUpperCase(),
    encodeURIComponent(value),
  ];
}

/**
 * Replace every occurrence of every secret value in `text` with `[secret:NAME]`.
 *
 * Best effort, and deliberately the LAST line rather than the design: what actually keeps
 * a credential away from the model is that it is injected as an environment variable and
 * never put in the prompt (see the module header). A determined command can always encode
 * a value in a shape nothing here anticipated; this makes the ordinary accidents — a tool
 * echoing its own configuration, a stack trace, a `| base64` — not leak.
 *
 * Every ENCODING of every value is redacted too, not just the literal (see `secretForms`).
 *
 * LONGEST FIRST across the whole set, because one form is often a prefix of another (a
 * token and the same token with a suffix; unpadded base64 and its padded sibling):
 * replacing the short one first would leave the long one half-redacted, and half a
 * credential in the transcript is still a leak.
 *
 * Values shorter than `MIN_SECRET_VALUE_CHARS` are skipped, and the API refuses to store
 * one — the two floors are the same constant precisely so this branch cannot be reached
 * by anything the user was allowed to save.
 *
 * Takes a map, or name/value PAIRS when one name legitimately carries two values: the
 * chats sharing a workspace each have their own `TOKEN`, and both must be redacted.
 */
export function redactSecrets(
  text: string,
  secrets: Record<string, string> | readonly (readonly [string, string])[],
): string {
  if (!text) return text;
  const entries = Array.isArray(secrets) ? secrets : Object.entries(secrets);
  const forms: { name: string; form: string }[] = [];
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (value.length < MIN_SECRET_VALUE_CHARS) continue;
    for (const form of secretForms(value)) {
      // Dedupe: url-safe base64 equals standard base64 for most values, and two chats
      // may store the same credential. A second pass over an already-replaced form is
      // harmless but pointless, and a stable first-wins keeps the label deterministic.
      if (form.length < MIN_SECRET_VALUE_CHARS || seen.has(form)) continue;
      seen.add(form);
      forms.push({ name, form });
    }
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  let out = text;
  for (const { name, form } of forms) out = out.split(form).join(`[secret:${name}]`);
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

/**
 * Every secret that could turn up in the output of a command run in THIS workspace,
 * as name/value pairs for `redactSecrets`.
 *
 * Injection is per chat; the workspace is not. A sandbox session — and the `/workspace`
 * bind mount under it — is keyed by `projectId ?? chatId` (`workspaceSessionKey`), so
 * every chat in a project shares one filesystem. A background job started by chat A
 * inherits A's secret env and tees its raw output into `/workspace/.capka/jobs/<id>/log`,
 * in that shared workspace; chat B then reads the file with a perfectly ordinary tool call. With
 * a per-chat redactor, B's turn knew nothing about A's credential and handed the model
 * the plaintext. So the set of values to REDACT is the union across the session key,
 * while the set to INJECT stays this chat's own.
 *
 * Scoped to `userId` as well as the session key. A project belongs to exactly one user
 * (`projects.user_id` is NOT NULL) and `/api/chat` refuses to retarget a chat to another
 * owner's project, so the union is already single-owner; the predicate says so out loud
 * rather than trusting that invariant to hold at every future write site.
 *
 * PAIRS, not a map: two chats in one project may each store a `TOKEN`, with different
 * values, and collapsing them by name would redact one and leak the other.
 */
export async function loadRedactionSecrets(sessionKey: string, userId: string): Promise<[string, string][]> {
  const rows = await db
    .select({ name: chatSecrets.name, valueEnc: chatSecrets.valueEnc })
    .from(chatSecrets)
    .innerJoin(chats, eq(chats.id, chatSecrets.chatId))
    .where(and(eq(chats.userId, userId), or(eq(chats.projectId, sessionKey), eq(chats.id, sessionKey))));
  if (rows.length === 0) return [];
  const key = await getMasterKey();
  const pairs: [string, string][] = [];
  for (const row of rows) {
    try {
      pairs.push([row.name, decrypt(row.valueEnc, key)]);
    } catch {
      // Same rule as `loadSecretEnv`: one undecryptable row must not take down the turn.
      log.warn("chat secret could not be decrypted; skipping redaction for it", { sessionKey, name: row.name });
    }
  }
  return pairs;
}
