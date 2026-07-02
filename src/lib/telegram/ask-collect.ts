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
};

const collections = new Map<number, Collection>();

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

/** Begin collecting answers for a suspended question. */
export async function startAskCollection(
  bot: Bot,
  chatId: number,
  init: { userId: string; messageId: string; form: AskForm; kind: "ask" | "elicitation"; locale?: string },
): Promise<void> {
  if (!init.form.fields.length) return;
  const c: Collection = { ...init, cursor: 0, collected: {} };
  collections.set(chatId, c);
  await promptField(bot, chatId, c);
}

/** Submit the collected values (or a skip) and clear the collection. */
async function finish(bot: Bot, chatId: number, c: Collection, action: AskAnswer["action"]): Promise<void> {
  collections.delete(chatId);
  const t = getTranslator(c.locale, "chat.ask");
  const d = { messageId: c.messageId, action, values: action === "submit" ? c.collected : {} };
  const { answerAskForUser, answerElicitationForUser } = await import("@/lib/ask/authed");
  if (c.kind === "elicitation") await answerElicitationForUser(c.userId, d);
  else await answerAskForUser(c.userId, d);
  await bot.api.sendMessage(chatId, action === "skip" ? t("skipped") : t("answered")).catch(() => {});
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
  const c = collections.get(chatId);
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
  const c = collections.get(chatId);
  if (!c || c.userId !== tapperUserId) return false;
  await finish(bot, chatId, c, "skip");
  return true;
}

/** A plain text message arrived. If a collection is active, the sender is the turn's
 *  OWNER, AND the current field is typed (text/number), capture it and advance —
 *  returns true so the caller does NOT treat the message as a new chat turn.
 *  Otherwise returns false. `senderUserId` is the Capka user who sent the message. */
export async function onAskText(bot: Bot, chatId: number, senderUserId: string, text: string): Promise<boolean> {
  const c = collections.get(chatId);
  if (!c || c.userId !== senderUserId) return false;
  const field = c.form.fields[c.cursor];
  if (field.kind !== "text" && field.kind !== "number") return false; // a choice field ignores stray text
  c.collected[field.id] = text;
  await advance(bot, chatId, c);
  return true;
}
