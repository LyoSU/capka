import { and, asc, count, eq, or } from "drizzle-orm";
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
 * The floor for a stored value, and the floor for the LITERAL form in the redactor.
 *
 * A value this short matches ordinary prose everywhere, so redacting it would shred the
 * output the model has to read. The redactor has always skipped such values; the API used
 * to accept them anyway, which stored a credential under a promise ("the model never sees
 * it") that nothing upstream kept. ONE constant, read by both the validator and the
 * redactor, is what makes the two ends agree — a floor enforced on only one side is the
 * hole, not the trade-off.
 *
 * SIX, not four, and the number is derived rather than chosen: see
 * `MIN_ENCODED_FORM_CHARS`. At four, `TOKEN=abcd` had an uncovered spelling —
 * `printf %s "$TOKEN" | base64 | tr -d =` prints the six-character `YWJjZA`, under the
 * encoded floor, so the model could read the credential back out through the exact bypass
 * the encoded forms were added to close.
 */
export const MIN_SECRET_VALUE_CHARS = 6;

/**
 * The floor for an ENCODED form, which is higher than the floor for the literal.
 *
 * Two floors, because the forms are not equally trustworthy. Six characters of base64
 * alphabet turn up inside ordinary identifiers, hashes and log lines that have nothing to
 * do with any credential, and replacing a fragment of someone's variable name with
 * `[secret:NAME]` is both wrong and alarming to read. The literal is the string the user
 * actually pasted, so a match on it is far likelier to be the real thing.
 *
 * INVARIANT, and the reason the raw floor is what it is: every form of every STORABLE
 * value clears this floor, so no valid value has an uncovered spelling. A six-character
 * value is at least six UTF-8 bytes, whose base64 is exactly eight characters with no
 * padding to strip (6 bytes = two complete groups), whose hex is twelve, and whose
 * percent-encoding is either identical to the literal — already covered at the raw floor,
 * and deduped — or longer, since encoding even one character costs three characters for
 * one. Lower the raw floor and that stops being true; `secretEncodings` is pinned to it
 * by a test for exactly that reason.
 */
export const MIN_ENCODED_FORM_CHARS = 8;

/**
 * The most credentials one sandbox session may hold, across every chat that shares it.
 *
 * The redactor's set is the union over the session (see `loadRedactionSecrets`), and
 * nothing bounds how many chats a project holds: 1,000 chats at the per-chat cap is 32,000
 * values, each expanded into several forms and each form driving its own full-string
 * `split`/`join` on EVERY tool result — a self-inflicted stall on the turn.
 *
 * Enforced at WRITE time, in the route, and deliberately NOT as a read-time cut. A cut
 * here was itself a leak: dropping the oldest pairs left an older-but-still-active
 * credential of a sibling chat unredacted, so a project of seventeen chats at the per-chat
 * cap handed chat A's secret to chat B out of the shared job log — the very hole the union
 * exists to close. A bound that refuses the 513th save keeps the guarantee total; a bound
 * that silently narrows the redactor cannot.
 */
export const MAX_SESSION_SECRETS = 512;

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

/**
 * A value is storable when it clears the redactor's floor, stays within the cap, carries
 * no NUL, and is well-formed UTF-16. The floor is `MIN_SECRET_VALUE_CHARS`, shared with
 * `redactSecrets`.
 *
 * A NUL cannot survive an environment variable and would truncate the value silently.
 *
 * An UNPAIRED surrogate (`"\ud800abc"`, reachable only from a hand-written JSON body, not
 * from typing) is refused because nothing downstream can carry it: `Buffer.from` turns it
 * into a replacement character, so its encoded forms describe a different string than the
 * one injected, and `encodeURIComponent` throws on it outright — which, before this check,
 * made the redactor fail EVERY tool result in the chat and in its project siblings, after
 * the command had already run.
 */
export function isValidSecretValue(value: string): boolean {
  return (
    value.length >= MIN_SECRET_VALUE_CHARS &&
    value.length <= MAX_SECRET_VALUE_CHARS &&
    !value.includes("\0") &&
    value.isWellFormed()
  );
}

/**
 * Every spelling of one value that the model could read back out as the value itself,
 * EXCLUDING the literal: base64 (standard and url-safe, padded and not), hex in both
 * cases, and percent-encoding. Encodings are of the UTF-8 bytes, which is what any tool
 * in the sandbox would encode.
 *
 * This list exists because `printf %s "$KEY" | base64` was a complete bypass of the
 * literal-only redactor: the model decodes it itself, so the transcript held the
 * credential in a form only a human reader would call redacted.
 *
 * The literal is the caller's to add, because the two carry different floors — see
 * `MIN_ENCODED_FORM_CHARS`.
 *
 * NEVER throws. `encodeURIComponent` rejects an unpaired surrogate, and a redactor that
 * can throw turns a command that already ran into a failed tool call — for this chat and
 * for every project sibling whose union includes the row. `isValidSecretValue` refuses
 * such a value now; a row stored before it did still reaches here.
 *
 * Exported for ONE reason: a test pins the `MIN_ENCODED_FORM_CHARS` invariant against it,
 * so lowering the raw floor cannot silently uncover a spelling. Not a call site.
 */
export function secretEncodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const b64 = bytes.toString("base64");
  const b64Url = b64.replace(/\+/g, "-").replace(/\//g, "_");
  const hex = bytes.toString("hex");
  const forms = [b64, b64.replace(/=+$/, ""), b64Url, b64Url.replace(/=+$/, ""), hex, hex.toUpperCase()];
  try {
    forms.push(encodeURIComponent(value));
  } catch {
    // A lone surrogate. The other forms above describe the replacement character rather
    // than this string, so they are useless too — but they cost nothing and cannot lie
    // about a value they do not match.
  }
  return forms;
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
 * by anything the user was allowed to save. An encoded form carries a HIGHER floor
 * (`MIN_ENCODED_FORM_CHARS`), because a short one matches unrelated identifiers.
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
  // Dedupe: url-safe base64 equals standard base64 for most values, and two chats may
  // store the same credential. A second pass over an already-replaced form is harmless
  // but pointless, and a stable first-wins keeps the label deterministic.
  const add = (name: string, form: string, floor: number) => {
    if (form.length < floor || seen.has(form)) return;
    seen.add(form);
    forms.push({ name, form });
  };
  for (const [name, value] of entries) {
    if (value.length < MIN_SECRET_VALUE_CHARS) continue;
    add(name, value, MIN_SECRET_VALUE_CHARS);
    for (const form of secretEncodings(value)) add(name, form, MIN_ENCODED_FORM_CHARS);
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
 *
 * A row the REDACTOR would not cover is skipped the same way, and this is the reason the
 * API's floor did not close the hole on its own: the validator only guards new writes,
 * while a value stored before it existed kept being injected into the container and
 * skipped by the redactor — the exact combination the floor was added to make impossible.
 * Enforcing it here as well means the two ends cannot drift again, whatever is already in
 * the table. Reported once per load with the names, not once per row: this runs on the
 * first command of every turn, and a per-row line would flood the ops log.
 */
export async function loadSecretEnv(chatId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ name: chatSecrets.name, valueEnc: chatSecrets.valueEnc })
    .from(chatSecrets)
    .where(eq(chatSecrets.chatId, chatId));
  if (rows.length === 0) return {};
  const key = await getMasterKey();
  const env: Record<string, string> = {};
  const unredactable: string[] = [];
  for (const row of rows) {
    let value: string;
    try {
      value = decrypt(row.valueEnc, key);
    } catch {
      // No value, no name-plus-value pairing, nothing that narrows the ciphertext.
      log.warn("chat secret could not be decrypted; skipping", { chatId, name: row.name });
      continue;
    }
    if (!isValidSecretValue(value)) {
      unredactable.push(row.name);
      continue;
    }
    env[row.name] = value;
  }
  if (unredactable.length > 0) {
    // Names only, never a value or a length — the point of the module.
    log.warn("chat secret is below the redaction floor or malformed; not injected", {
      chatId,
      names: unredactable.join(","),
    });
  }
  return env;
}

/**
 * The rows belonging to one sandbox session: every chat that shares the session key, and
 * only this owner's.
 *
 * A session key is `projectId ?? chatId` (`workspaceSessionKey`), so it is a project id
 * for a chat in a project and the chat's own id otherwise — hence both columns. Chat ids
 * and project ids are distinct nanoids, so matching both can never widen the set.
 *
 * The `userId` predicate is belt-and-braces: a project belongs to exactly one user
 * (`projects.user_id` is NOT NULL) and `/api/chat` refuses to retarget a chat into another
 * owner's project. It is written out so a future write site cannot quietly make the union
 * cross an owner boundary.
 */
function sessionSecretScope(sessionKey: string, userId: string) {
  return and(eq(chats.userId, userId), or(eq(chats.projectId, sessionKey), eq(chats.id, sessionKey)));
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
 * Scoped to the owner as well as the session key — see `sessionSecretScope`.
 *
 * PAIRS, not a map: two chats in one project may each store a `TOKEN`, with different
 * values, and collapsing them by name would redact one and leak the other.
 *
 * EVERY row in the session, with no cut. The size problem is real, but a read-time cut is
 * the wrong end of it: dropping the oldest pairs leaves an older-but-still-active sibling
 * credential unredacted, which is the leak the union exists to close. It is bounded at
 * write time instead (`MAX_SESSION_SECRETS`, refused by the route), so this query is
 * bounded too — and a workspace already over the bound from before it existed is warned
 * about and still covered in full.
 *
 * KNOWN LIMIT, accepted rather than fixed: a value that has been deleted or rotated is no
 * longer in this union, so its old plaintext survives in whatever job log under
 * `/workspace/.capka/jobs/` already holds it, and is readable again.
 * The log lives in the owner's own workspace and
 * is theirs to clear; scrubbing the filesystem on a delete is a different job from this one.
 */
export async function loadRedactionSecrets(sessionKey: string, userId: string): Promise<[string, string][]> {
  const rows = await db
    .select({ name: chatSecrets.name, valueEnc: chatSecrets.valueEnc })
    .from(chatSecrets)
    .innerJoin(chats, eq(chats.id, chatSecrets.chatId))
    .where(sessionSecretScope(sessionKey, userId));
  if (rows.length === 0) return [];
  if (rows.length > MAX_SESSION_SECRETS) {
    // Only reachable from data written before the write-time bound existed. Redacted in
    // full anyway — the cost is a slower turn, and the alternative was a silent leak.
    log.warn("workspace holds more secrets than the session bound; redaction will be slow", {
      sessionKey,
      count: rows.length,
      bound: MAX_SESSION_SECRETS,
    });
  }
  const key = await getMasterKey();
  const pairs: [string, string][] = [];
  for (const row of rows) {
    let value: string;
    try {
      value = decrypt(row.valueEnc, key);
    } catch {
      // Same rule as `loadSecretEnv`: one undecryptable row must not take down the turn.
      log.warn("chat secret could not be decrypted; skipping redaction for it", { sessionKey, name: row.name });
      continue;
    }
    // A value the redactor would skip anyway (a pre-floor row) contributes nothing.
    if (isValidSecretValue(value)) pairs.push([row.name, value]);
  }
  return pairs;
}

/**
 * How many credentials the whole sandbox session already holds — the quantity
 * `MAX_SESSION_SECRETS` bounds, for the route to check before it stores one more.
 *
 * Shares `sessionSecretScope` with `loadRedactionSecrets` on purpose: the number the
 * route refuses on and the set the redactor covers have to be the same set, or the bound
 * guards something other than the thing it is protecting.
 */
export async function countSessionSecrets(sessionKey: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(chatSecrets)
    .innerJoin(chats, eq(chats.id, chatSecrets.chatId))
    .where(sessionSecretScope(sessionKey, userId));
  return Number(row?.n ?? 0);
}
