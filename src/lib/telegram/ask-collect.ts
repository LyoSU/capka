import { InlineKeyboard, type Bot } from "grammy";
import { getTranslator } from "@/lib/i18n/translator";
import type { AskForm, AskField, AskAnswer } from "@/lib/ask/types";

/**
 * Sequential `ask`/elicitation collection on Telegram. A multi-field form has no
 * native Telegram surface, so we ask ONE field per message: a choice/boolean field
 * sends inline buttons, a text/number field prompts and reads the user's next
 * message. State is a per-Telegram-chat map — the bot and the worker's delivery
 * sink share this process, so an in-memory map is enough (a bot restart drops an
 * in-flight collection, which is acceptable — the user just re-triggers).
 *
 * Multi-select choices degrade to single-select here (one tap finishes the field);
 * the web card keeps full multi-select.
 */
type Collection = {
  userId: string;
  messageId: string;
  form: AskForm;
  kind: "ask" | "elicitation";
  locale?: string;
  cursor: number;
  collected: Record<string, string | string[]>;
  /** Absolute expiry (ms). An MCP elicitation blocks a live tool call for ~3 min
   *  then deletes its DB row (see mcp/elicitation); the Telegram collection must
   *  expire on the SAME deadline, or a late reply is swallowed by a dead question
   *  (and reported "answered") while the tool call already timed out. A durable
   *  `ask` has no expiry — its DB snapshot waits indefinitely. */
  expiresAt?: number;
};

const collections = new Map<number, Collection>();

/** The active, NON-expired collection for a chat, if any. An expired one is
 *  dropped here so every interaction path (button/skip/text) treats it as gone. */
function live(chatId: number): Collection | undefined {
  const c = collections.get(chatId);
  if (!c) return undefined;
  if (c.expiresAt !== undefined && Date.now() >= c.expiresAt) {
    collections.delete(chatId);
    return undefined;
  }
  return c;
}

/** Options a field offers as buttons (choice, or a synthetic yes/no for boolean);
 *  null for a free-text/number field that must be typed. */
function fieldOptions(field: AskField, t: ReturnType<typeof getTranslator>): { value: string; label: string }[] | null {
  if (field.kind === "choice") return field.options ?? [];
  if (field.kind === "boolean") return [{ value: "true", label: t("yes") }, { value: "false", label: t("no") }];
  return null;
}

/** Send the current cursor field's prompt (buttons or a typed prompt), always with
 *  a Skip button so the user can decline the whole question. */
async function promptField(bot: Bot, chatId: number, c: Collection): Promise<void> {
  const t = getTranslator(c.locale, "chat.ask");
  const field = c.form.fields[c.cursor];
  const opts = fieldOptions(field, t);
  const kb = new InlineKeyboard();
  if (opts) {
    opts.forEach((op, i) => kb.text(op.label, `ta:${c.cursor}:${i}`).row());
  }
  kb.text(t("skip"), "taskip");
  await bot.api.sendMessage(chatId, field.label, { reply_markup: kb }).catch(() => {});
}

/** Begin collecting answers for a suspended question. `ttlMs` bounds how long the
 *  in-memory collection stays live — pass the elicitation's own timeout so a late
 *  reply after the tool call gave up isn't captured; omit it for a durable `ask`. */
export async function startAskCollection(
  bot: Bot,
  chatId: number,
  init: { userId: string; messageId: string; form: AskForm; kind: "ask" | "elicitation"; locale?: string; ttlMs?: number },
): Promise<void> {
  if (!init.form.fields.length) return;
  // Sweep any expired entries so an abandoned question can't linger in the map.
  for (const [id, c] of collections) if (c.expiresAt !== undefined && Date.now() >= c.expiresAt) collections.delete(id);
  const c: Collection = {
    userId: init.userId, messageId: init.messageId, form: init.form, kind: init.kind, locale: init.locale,
    cursor: 0, collected: {}, expiresAt: init.ttlMs !== undefined ? Date.now() + init.ttlMs : undefined,
  };
  collections.set(chatId, c);
  await promptField(bot, chatId, c);
}

/** Submit the collected values (or a skip) and clear the collection. Confirms only
 *  when the answer actually landed: the answer* helpers return false when the
 *  suspended question is already resolved or gone (an elicitation that timed out
 *  and deleted its row, a double-submit), so we say "expired" rather than falsely
 *  reporting success. */
async function finish(bot: Bot, chatId: number, c: Collection, action: AskAnswer["action"]): Promise<void> {
  collections.delete(chatId);
  const t = getTranslator(c.locale, "chat.ask");
  const d = { messageId: c.messageId, action, values: action === "submit" ? c.collected : {} };
  const { answerAskForUser, answerElicitationForUser } = await import("@/lib/ask/authed");
  const ok = c.kind === "elicitation" ? await answerElicitationForUser(c.userId, d) : await answerAskForUser(c.userId, d);
  const msg = !ok ? t("expired") : action === "skip" ? t("skipped") : t("answered");
  await bot.api.sendMessage(chatId, msg).catch(() => {});
}

/** Advance to the next field, or submit when the last one is done. */
async function advance(bot: Bot, chatId: number, c: Collection): Promise<void> {
  c.cursor += 1;
  if (c.cursor >= c.form.fields.length) await finish(bot, chatId, c, "submit");
  else await promptField(bot, chatId, c);
}

/** A choice/boolean button was tapped. `tapperUserId` is the Capka user who tapped
 *  (from their Telegram link) — only the turn's OWNER may answer, so a different
 *  member of a group chat can't resume someone else's turn with chosen input.
 *  Returns false if no collection is active / the tapper isn't the owner. */
export async function onAskChoice(bot: Bot, chatId: number, tapperUserId: string, fieldIdx: number, optIdx: number): Promise<boolean> {
  const c = live(chatId);
  if (!c || c.userId !== tapperUserId || c.cursor !== fieldIdx) return false;
  const t = getTranslator(c.locale, "chat.ask");
  const opts = fieldOptions(c.form.fields[fieldIdx], t);
  const value = opts?.[optIdx]?.value;
  if (value === undefined) return false;
  c.collected[c.form.fields[fieldIdx].id] = value;
  await advance(bot, chatId, c);
  return true;
}

/** The Skip button was tapped. Only the turn's owner may skip. Returns false if no
 *  collection is active / the tapper isn't the owner. */
export async function onAskSkip(bot: Bot, chatId: number, tapperUserId: string): Promise<boolean> {
  const c = live(chatId);
  if (!c || c.userId !== tapperUserId) return false;
  await finish(bot, chatId, c, "skip");
  return true;
}

/** A plain text message arrived. If a collection is active, the sender is the turn's
 *  OWNER, AND the current field is typed (text/number), capture it and advance —
 *  returns true so the caller does NOT treat the message as a new chat turn.
 *  Otherwise returns false. `senderUserId` is the Capka user who sent the message. */
export async function onAskText(bot: Bot, chatId: number, senderUserId: string, text: string): Promise<boolean> {
  // `live` drops an expired collection, so a late free-text reply returns false and
  // the caller treats it as a fresh Telegram turn instead of swallowing it here.
  const c = live(chatId);
  if (!c || c.userId !== senderUserId) return false;
  const field = c.form.fields[c.cursor];
  if (field.kind !== "text" && field.kind !== "number") return false; // a choice field ignores stray text
  c.collected[field.id] = text;
  await advance(bot, chatId, c);
  return true;
}
