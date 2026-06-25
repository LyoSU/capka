import { Bot, InlineKeyboard, type Context } from "grammy";
import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import { eq, and, ne, desc, isNotNull } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { telegramLinks, linkCodes, chats, messages, users, accounts } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { publishTaskEvent } from "@/lib/tasks/events";
import { enqueueTask } from "@/lib/tasks/queue";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { reserveBudget, releaseHold } from "@/lib/billing/limits";
import { toUIMessages } from "@/lib/chat/presenter";
import { loadActivePath } from "@/lib/chat/tree";
import { take } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { getTranslator } from "@/lib/i18n/translator";
import { getPublicUrl } from "@/lib/url";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { uploadFile } from "@/lib/sandbox/client";
import { modelChoices } from "@/lib/telegram/model-menu";
import type { FileRef } from "@/lib/constants";
import type { TaskPayload } from "@/lib/tasks/runner";

// Bot lifecycle state lives on globalThis, NOT in module scope. In dev, an HMR
// recompile (or a second `register()`) re-evaluates this module — module-level
// `let`s would reset to null/false and `startBot()` would spin up a SECOND
// long-poller while the old module's poller keeps running in its closure. Two
// pollers on one token race getUpdates and can each deliver/answer, so the bot
// appears to reply multiple times. `globalThis` survives re-evaluation (same
// Node process), so the singleton + polling guard are honored across reloads —
// the same trick the durable worker uses (see worker.ts `globalThis.__worker`).
interface BotState {
  bot: Bot | null;
  // Memoizes the in-flight `new Bot(token)` build so two concurrent first-callers
  // (a delivery flush + a keepalive refresh) don't each construct a bot and have
  // the second clobber — and discard — the first live instance.
  botPromise: Promise<Bot | null> | null;
  polling: boolean;
  // Captured when the bot is built — needed to construct file download URLs
  // (`https://api.telegram.org/file/bot<token>/<path>`), the one place the Bot
  // API has no method wrapper for.
  token: string;
  // The pooled connection that holds the poll-leader advisory lock for this
  // process. Held for our lifetime while we're the leader; releasing it (or the
  // process dying) drops the lock so a standby instance can take over.
  leaderClient: PoolClient | null;
  // Set on a standby instance: the interval that keeps campaigning for the lock.
  leaderTimer: ReturnType<typeof setInterval> | null;
}
const g = globalThis as unknown as { __telegramBot?: BotState };
function botState(): BotState {
  if (!g.__telegramBot)
    g.__telegramBot = { bot: null, botPromise: null, polling: false, token: "", leaderClient: null, leaderTimer: null };
  return g.__telegramBot;
}

const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024; // getFile's hard download cap

// The command menu Telegram shows behind the "/" hint. Registered under the
// default scope — English only, by design: the set is tiny and the menu is the
// one surface where per-locale upkeep isn't worth it (replies still localize to
// the user's client language).
const BOT_COMMANDS = [
  { command: "start", description: "Show the welcome message" },
  { command: "new", description: "Start a new chat" },
  { command: "model", description: "Switch the model for this chat" },
];

// Bot replies follow the user's own Telegram client language (falling back to
// English), so a user never has to configure anything to be understood.
const tFor = (ctx: Context) => getTranslator(ctx.from?.language_code, "telegram");

/** Each interpolated value lands inside a backtick code span in the catalog
 *  (e.g. a filename or error), so the one character that could break out of it
 *  is the backtick. Swap it for a typographic quote — code spans render the rest
 *  literally, so no other Markdown escaping is needed. */
const escapeCode = (s: string) => s.replace(/`/g, "ʼ");

/** A localized URL button. `label` is a catalog key (so the button text follows
 *  the user's client language); `url` is absolute. */
type Button = { label: string; url: string };

/** Public-origin link builders, resolved at call time so a runtime PUBLIC_URL
 *  (or proxy origin) is always reflected. The bot polls outside any request, so
 *  there are no headers — getPublicUrl falls back to PUBLIC_URL / localhost. */
const openAppButton = (): Button => ({ label: "openApp", url: getPublicUrl() });
const openChatButton = (chatId?: string): Button => ({
  label: "openInBrowser",
  url: chatId ? `${getPublicUrl()}/chat/${chatId}` : `${getPublicUrl()}/chat`,
});

/**
 * Send a localized reply as a Bot API 10.1 Rich Message (the same Markdown
 * channel the runner delivers answers through, so the whole bot speaks one
 * formatting dialect), with an optional URL button. Interpolated values are
 * escaped for the code span they sit in. If Telegram rejects the button URL — a
 * localhost dev origin has no TLD and gets a BUTTON_URL_INVALID — we retry
 * without the keyboard so the text always lands.
 */
async function reply(
  ctx: Context,
  key: string,
  opts: { values?: Record<string, string | number>; button?: Button } = {},
): Promise<void> {
  const t = tFor(ctx);
  const values = opts.values
    ? Object.fromEntries(
        Object.entries(opts.values).map(([k, v]) => [k, typeof v === "string" ? escapeCode(v) : v]),
      )
    : undefined;
  const markdown = t(key, values);
  // Button labels are plain text in Telegram's UI — no Markdown is rendered there.
  const keyboard = opts.button ? new InlineKeyboard().url(t(opts.button.label), opts.button.url) : undefined;
  try {
    await ctx.replyWithRichMessage({ markdown }, keyboard ? { reply_markup: keyboard } : undefined);
  } catch (e) {
    if (!keyboard) {
      log.warn("telegram reply failed", { key, err: String(e) });
      return;
    }
    // A bad button URL must not eat the message — resend it without the keyboard.
    await ctx
      .replyWithRichMessage({ markdown })
      .catch((e2) => log.warn("telegram reply failed", { key, err: String(e2) }));
  }
}

type TgFile = { fileId: string; fileName: string; mime: string };

/** Pull every usable file descriptor out of an incoming message. Photos arrive
 *  as a size ladder — we take the largest. Names/MIME fall back to sensible
 *  defaults so even nameless voice notes land as real files in the workspace. */
function extractFiles(msg: NonNullable<Context["message"]>): TgFile[] {
  const out: TgFile[] = [];
  const d = msg.document;
  if (d) out.push({ fileId: d.file_id, fileName: d.file_name || `file_${d.file_unique_id}`, mime: d.mime_type || "application/octet-stream" });
  if (msg.photo?.length) {
    const ph = msg.photo[msg.photo.length - 1];
    out.push({ fileId: ph.file_id, fileName: `photo_${ph.file_unique_id}.jpg`, mime: "image/jpeg" });
  }
  const v = msg.video;
  if (v) out.push({ fileId: v.file_id, fileName: v.file_name || `video_${v.file_unique_id}.mp4`, mime: v.mime_type || "video/mp4" });
  const a = msg.audio;
  if (a) out.push({ fileId: a.file_id, fileName: a.file_name || `audio_${a.file_unique_id}.mp3`, mime: a.mime_type || "audio/mpeg" });
  if (msg.voice) out.push({ fileId: msg.voice.file_id, fileName: `voice_${msg.voice.file_unique_id}.ogg`, mime: msg.voice.mime_type || "audio/ogg" });
  const an = msg.animation;
  if (an) out.push({ fileId: an.file_id, fileName: an.file_name || `animation_${an.file_unique_id}.mp4`, mime: an.mime_type || "video/mp4" });
  if (msg.video_note) out.push({ fileId: msg.video_note.file_id, fileName: `videonote_${msg.video_note.file_unique_id}.mp4`, mime: "video/mp4" });
  return out;
}

/** Fetch a Telegram file's bytes as a `File` ready for the sandbox upload, or
 *  null if it exceeds the Bot API's 20 MB download cap. */
async function downloadTgFile(ctx: Context, f: TgFile): Promise<File | null> {
  const info = await ctx.api.getFile(f.fileId);
  if (!info.file_path || (info.file_size ?? 0) > MAX_TELEGRAM_FILE_BYTES) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${botState().token}/${info.file_path}`);
  if (!res.ok) return null;
  return new File([Buffer.from(await res.arrayBuffer())], f.fileName, { type: f.mime });
}

// Album (media-group) coalescing. Telegram sends each photo of an album as its
// own update sharing a media_group_id, with the caption usually only on the
// first. We collect parts and ingest once the burst settles.
const ALBUM_DEBOUNCE_MS = 1500;
const albums = new Map<string, { ctx: Context; text: string; files: TgFile[]; timer: ReturnType<typeof setTimeout> }>();

function bufferAlbum(ctx: Context, groupId: string, text: string, files: TgFile[]): void {
  const existing = albums.get(groupId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.files.push(...files);
    if (text && !existing.text) existing.text = text;
    existing.timer = setTimeout(() => void flushAlbum(groupId), ALBUM_DEBOUNCE_MS);
    return;
  }
  albums.set(groupId, { ctx, text, files, timer: setTimeout(() => void flushAlbum(groupId), ALBUM_DEBOUNCE_MS) });
}

function flushAlbum(groupId: string): void {
  const p = albums.get(groupId);
  if (!p) return;
  albums.delete(groupId);
  void ingest(p.ctx, p.text, p.files);
}

/**
 * The single entry point for an incoming user turn (text and/or files). Mirrors
 * the web enqueue path: resolve the link's pinned Telegram chat, push any files
 * into the sandbox, save the user message on the active branch, and enqueue a
 * durable task whose result the runner streams back to this chat.
 */
async function ingest(ctx: Context, text: string, files: TgFile[]): Promise<void> {
  const link = await findLink(ctx.from!.id);
  if (!link) {
    await reply(ctx, "notLinked", { button: openAppButton() });
    return;
  }
  // Approval gate: a pending account must not spend the shared key from Telegram
  // either — mirror the web /api/chat guard. (A Telegram login auto-links before
  // approval, so without this a pending user could DM the bot to slip past it.)
  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, link.userId)).limit(1);
  if (u?.status === "pending") {
    await reply(ctx, "pendingApproval", { button: { label: "openApp", url: `${getPublicUrl()}/pending` } });
    return;
  }
  // Same per-user flood guard as the web enqueue path.
  if (!take(`chat:${link.userId}`).ok) {
    await reply(ctx, "tooFast");
    return;
  }

  // Route into the link's pinned Telegram chat — NOT "whatever the user last
  // touched on the web", which would mix Telegram replies into web/project
  // chats and lose project context.
  const title = (text || files[0]?.fileName || "Telegram Chat").slice(0, 100);
  const chat = await resolveActiveChat(link, title);
  const sessionKey = workspaceSessionKey({ id: chat.id, projectId: chat.projectId ?? null });

  // Same shared-key budget gate as the web path — a user must not sidestep their
  // limit via Telegram. Reserve an estimated hold up front (atomic, per-user); the
  // runner reconciles it to the real cost, or it's released if the turn folds.
  // Gated before any file download so a blocked user wastes no work.
  const tgTaskId = nanoid();
  const { isShared: tgShared, modelId: tgModelId, provider: tgProvider } = await resolveUserModelInfo(link.userId, chat.model ?? undefined);
  const reservation = await reserveBudget({
    userId: link.userId, taskId: tgTaskId, onSharedKey: tgShared, modelId: tgModelId, provider: tgProvider,
  });
  if (!reservation.allowed) {
    if (reservation.reason === "unpriced") {
      await ctx.reply("This model isn't priced, so it can't run on the shared key — please ask an admin to sync models or pick another model.").catch(() => {});
    } else {
      await reply(ctx, "budgetReached");
    }
    return;
  }

  // Pull each Telegram file into the user's sandbox so the assistant can read,
  // run or analyze it — passed through as attachedFiles, exactly like the web.
  const attachedFiles: FileRef[] = [];
  for (const f of files) {
    try {
      const file = await downloadTgFile(ctx, f);
      if (!file) {
        await reply(ctx, "fileTooBig", { values: { name: f.fileName } });
        continue;
      }
      await uploadFile(sessionKey, ".", file, link.userId);
      attachedFiles.push({ name: f.fileName, type: f.mime });
    } catch (e) {
      log.warn("telegram file ingest failed", { name: f.fileName, err: String(e) });
    }
  }

  // Save user message — chained onto the chat's current leaf so the conversation
  // tree stays linear and the web view shows full history.
  const tgUserId = nanoid();
  await db.insert(messages).values({
    id: tgUserId,
    chatId: chat.id,
    parentId: chat.activeLeafId ?? null,
    role: "user",
    content: text,
    platform: "telegram",
    telegramMessageId: ctx.message?.message_id,
    // Record the attachments (reference metadata only — bytes live in the
    // sandbox) so the web transcript shows them on the user bubble, exactly like
    // a file sent from the web chat.
    metadata: attachedFiles.length ? { attachedFiles } : null,
  });
  // Name the chat from its first real message — like the web does. The chat may
  // have been created generically (/new, or a file-only first turn), so update
  // the title while it's still the placeholder rather than only at creation.
  const needsTitle = (!chat.title || chat.title === "Telegram Chat") && Boolean(text.trim());
  await db.update(chats).set({
    activeLeafId: tgUserId,
    updatedAt: new Date(),
    ...(needsTitle ? { title: text.slice(0, 100) } : {}),
  }).where(eq(chats.id, chat.id));
  await publishTaskEvent(link.userId, { type: "new_message", chatId: chat.id });

  try {
    // Answer from the active branch (root → the message we just added).
    const path = await loadActivePath(chat.id, tgUserId);
    const payload: TaskPayload = {
      requestModel: chat.model ?? undefined,
      projectId: chat.projectId ?? undefined,
      uiMessages: toUIMessages(path.map((p) => p.node)),
      attachedFiles: attachedFiles.length ? attachedFiles : undefined,
      origin: { platform: "telegram", telegramChatId: ctx.chat!.id, locale: ctx.from?.language_code },
    };
    const { created } = await enqueueTask({ id: tgTaskId, chatId: chat.id, userId: link.userId, payload });
    // Folded into an existing turn — our reserved turn won't run, so release its
    // hold; the turn that answers carries its own hold.
    if (!created) await releaseHold(tgTaskId);
    await ctx.replyWithChatAction("typing").catch(() => {});
  } catch (error: unknown) {
    // The turn never got enqueued — release its budget hold so it doesn't leak.
    await releaseHold(tgTaskId);
    await reply(ctx, "startError", { values: { error: error instanceof Error ? error.message : "Unknown error" } });
  }
}

export async function getBot(): Promise<Bot | null> {
  const s = botState();
  if (s.bot) return s.bot;
  // Single-flight: concurrent callers share one build instead of racing to
  // `new Bot()` and clobbering each other's instance.
  if (s.botPromise) return s.botPromise;
  s.botPromise = buildBot();
  try {
    return await s.botPromise;
  } finally {
    s.botPromise = null;
  }
}

async function buildBot(): Promise<Bot | null> {
  const s = botState();
  if (s.bot) return s.bot;
  const token = await getSetting("telegram_bot_token");
  if (!token) return null;

  s.token = token;
  const bot = new Bot(token);

  // A bare /start greets; /start CODE is the deep-link path — tapping
  // `t.me/<bot>?start=CODE` in the web UI arrives here and links in one tap.
  bot.command("start", async (ctx) => {
    const code = ctx.match?.trim().toUpperCase();
    if (code) {
      await linkAccount(ctx, code);
      return;
    }
    // A bare /start greets — but tailor it: an already-linked user gets a "you're
    // set, just message me" nudge to the web UI, a stranger gets the onboarding
    // path to sign in.
    const link = await findLink(ctx.from!.id);
    if (link) {
      await reply(ctx, "startLinked", { button: openChatButton() });
    } else {
      await reply(ctx, "start", { button: openAppButton() });
    }
  });

  bot.command("link", async (ctx) => {
    const code = ctx.match?.trim().toUpperCase();
    if (!code) {
      await reply(ctx, "linkUsage");
      return;
    }
    await linkAccount(ctx, code);
  });

  bot.command("new", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await reply(ctx, "linkFirst", { button: openAppButton() });
      return;
    }
    const id = nanoid();
    await db
      .insert(chats)
      .values({ id, userId: link.userId, title: "Telegram Chat", source: "telegram", model: await lastUsedModel(link.userId) });
    await db.update(telegramLinks).set({ activeChatId: id }).where(eq(telegramLinks.id, link.id));
    await reply(ctx, "newChat", { button: openChatButton(id) });
  });

  // Pick the model for the active Telegram chat from a short, capability-tagged
  // list. The menu is a one-per-row inline keyboard; the tap is handled by the
  // `m:<index>` callback below, which re-derives the same list and stores the ref.
  bot.command("model", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await reply(ctx, "linkFirst", { button: openAppButton() });
      return;
    }
    const choices = await modelChoices(link.userId);
    if (!choices.length) {
      await reply(ctx, "modelEmpty");
      return;
    }
    const kb = new InlineKeyboard();
    choices.forEach((c, i) => kb.text(c.label, `m:${i}`).row());
    await ctx
      .replyWithRichMessage({ markdown: tFor(ctx)("modelPrompt") }, { reply_markup: kb })
      .catch((e) => log.warn("telegram model menu failed", { err: String(e) }));
  });

  // A model was tapped: re-derive the same deterministic list and pin the chosen
  // ref on the active chat. callback_data is just the index, so a long model ref
  // never trips Telegram's 64-byte callback limit.
  bot.callbackQuery(/^m:(\d+)$/, async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await ctx.answerCallbackQuery();
      return;
    }
    const choices = await modelChoices(link.userId);
    const choice = choices[Number(ctx.match![1])];
    await ctx.answerCallbackQuery();
    if (!choice) {
      await reply(ctx, "modelStale");
      return;
    }
    const chat = await resolveActiveChat(link, "Telegram Chat");
    await db.update(chats).set({ model: choice.ref, updatedAt: new Date() }).where(eq(chats.id, chat.id));
    await ctx.editMessageReplyMarkup().catch(() => {});
    await reply(ctx, "modelSet", { values: { model: choice.label } });
  });

  // Plain text → straight into the engine.
  bot.on("message:text", (ctx) => ingest(ctx, ctx.message.text, []));

  // Any message carrying a file the assistant can use: photo, document, video,
  // audio, voice, animation, video note. The caption is the prompt. Telegram
  // delivers an album (media group) as several updates sharing a
  // `media_group_id`, so we buffer those and ingest them as one turn.
  bot.on(
    ["message:photo", "message:document", "message:video", "message:audio", "message:voice", "message:animation", "message:video_note"],
    async (ctx) => {
      const files = extractFiles(ctx.message);
      const text = ctx.message.caption ?? "";
      if (ctx.message.media_group_id) {
        bufferAlbum(ctx, ctx.message.media_group_id, text, files);
        return;
      }
      await ingest(ctx, text, files);
    },
  );

  // Everything else (stickers, locations, contacts, polls…). Rather than
  // silently dropping it, tell the user what the bot can actually work with.
  bot.on("message", (ctx) => reply(ctx, "unsupported"));

  // Without this, a throwing handler is either swallowed or crashes the polling
  // process depending on the runtime. Log it and keep the bot alive.
  bot.catch((err) => {
    log.error("telegram handler error", { updateId: err.ctx.update.update_id, err: String(err.error) });
  });

  s.bot = bot;
  return bot;
}

/** The model the user most recently used in any chat — what a NEW Telegram chat
 *  inherits, so a voice note isn't silently handed to an audio-incapable default
 *  model. Null when the user has never pinned a model (then the default config's
 *  model applies, exactly as before). */
async function lastUsedModel(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ model: chats.model })
    .from(chats)
    .where(and(eq(chats.userId, userId), isNotNull(chats.model)))
    .orderBy(desc(chats.updatedAt))
    .limit(1);
  return row?.model ?? null;
}

/**
 * Resolve the chat Telegram messages belong to: the link's pinned active chat
 * if it still exists, otherwise a fresh dedicated chat that we then pin.
 */
async function resolveActiveChat(
  link: { id: string; userId: string; activeChatId: string | null },
  firstMessage: string,
) {
  if (link.activeChatId) {
    const [c] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, link.activeChatId), eq(chats.userId, link.userId)))
      .limit(1);
    if (c) return c;
  }
  // Telegram can deliver two messages back-to-back; without serialization both
  // would see a null activeChatId and each create a chat, leaving one orphaned
  // ("why did it reply in a new chat?"). Lock the link row so the second message
  // blocks until the first commits, then re-checks and reuses the pinned chat.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ activeChatId: telegramLinks.activeChatId })
      .from(telegramLinks)
      .where(eq(telegramLinks.id, link.id))
      .for("update");
    if (locked?.activeChatId) {
      const [existing] = await tx
        .select()
        .from(chats)
        .where(and(eq(chats.id, locked.activeChatId), eq(chats.userId, link.userId)))
        .limit(1);
      if (existing) return existing;
    }
    const id = nanoid();
    await tx.insert(chats).values({ id, userId: link.userId, title: firstMessage || "Telegram Chat", source: "telegram", model: await lastUsedModel(link.userId) });
    await tx.update(telegramLinks).set({ activeChatId: id }).where(eq(telegramLinks.id, link.id));
    const [created] = await tx.select().from(chats).where(eq(chats.id, id)).limit(1);
    return created;
  });
}

/**
 * Start the bot in long-polling mode — no public webhook URL needed, works
 * behind NAT, and the bot becomes a persistent process that the runner can
 * deliver replies through. Idempotent; a no-op if no token is configured.
 */
// Only ONE process may long-poll a given bot token: Telegram hands the same
// getUpdates batch to whichever poller asks, so two pollers double-process every
// command and double-deliver. Across multiple app instances the per-process
// `polling` guard isn't enough, so we elect a single poll leader with a
// session-level Postgres advisory lock — the holder polls, the rest stand by.
// If the leader's process dies its connection drops and the lock releases, so a
// standby takes over on its next retry. No manual failover, no webhook needed.
const POLLER_LOCK_KEY = 0x756e636c; // 'uncl' — stable, arbitrary 32-bit key
const LEADER_RETRY_MS = 15_000;

async function tryAcquirePollerLock(): Promise<boolean> {
  const s = botState();
  if (s.leaderClient) return true; // already the leader
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [POLLER_LOCK_KEY],
    );
    if (rows[0]?.locked) {
      // Hold the connection — and thus the lock — for our lifetime.
      s.leaderClient = client;
      // If this connection drops, Postgres releases the advisory lock with it, so
      // we must stop polling and re-campaign — otherwise a standby takes the lock
      // and we'd double-poll the same token. (pg emits 'error' on backend/socket
      // failure.) Listen once; relinquish is idempotent.
      client.on("error", (err) => {
        log.warn("telegram poll-leader connection lost — relinquishing", {
          error: err instanceof Error ? err.message : String(err),
        });
        void relinquishLeadership();
      });
      return true;
    }
  } catch (e) {
    log.error("telegram poller lock check failed", { error: e instanceof Error ? e.message : String(e) });
  }
  client.release();
  return false;
}

/** Give up poll leadership after losing the lock connection, then re-campaign. */
async function relinquishLeadership(): Promise<void> {
  const s = botState();
  if (!s.leaderClient && !s.polling) return; // already relinquished
  // The lock is already gone with the dead connection — drop the handle without
  // release() (the client is broken; the pool reaps it) and stop polling so we
  // don't keep getUpdates running without the lock alongside the new leader.
  s.leaderClient = null;
  if (s.leaderTimer) { clearInterval(s.leaderTimer); s.leaderTimer = null; }
  const bot = s.bot;
  s.polling = false;
  if (bot) {
    try { await bot.stop(); } catch (e) {
      log.error("telegram stop on relinquish failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Re-enter the campaign: reacquire the lock (likely, if we were just blipped) or
  // stand by under whoever took over.
  await startBot();
}

function releasePollerLock(): void {
  const s = botState();
  if (s.leaderTimer) {
    clearInterval(s.leaderTimer);
    s.leaderTimer = null;
  }
  if (s.leaderClient) {
    // Releasing the connection drops the session and its advisory lock, letting
    // a standby instance take over the poll.
    s.leaderClient.release();
    s.leaderClient = null;
  }
}

export async function startBot(): Promise<void> {
  const s = botState();
  if (s.polling || s.leaderTimer) return; // already polling, or already campaigning
  const bot = await getBot();
  if (!bot) return;

  const beginPolling = async () => {
    if (s.polling) return;
    s.polling = true;
    // Drop any previously-registered webhook so getUpdates won't 409.
    await bot.api.deleteWebhook().catch(() => {});
    // Publish the "/" command menu (English default scope). Best-effort: a hiccup
    // here must not stop polling.
    await bot.api.setMyCommands(BOT_COMMANDS).catch(() => {});
    // bot.start() resolves only when the bot stops, so never await it here.
    void bot.start({
      onStart: (info) => {
        log.info("telegram polling started", { username: info.username });
        // Cache the bot's @username (public, not a secret) so the web UI can build
        // the one-tap link deep link without an admin-only token read. Also
        // backfills installs whose token was saved before this field existed.
        void setSetting("telegram_bot_username", info.username, false);
      },
    });
  };

  // Become the single poll leader if we can; otherwise stand by and keep
  // campaigning so we take over when the current leader dies.
  if (await tryAcquirePollerLock()) {
    await beginPolling();
    return;
  }
  log.info("telegram poller standing by — another instance holds the poll lock");
  s.leaderTimer = setInterval(() => {
    void (async () => {
      if (s.polling) return;
      if (await tryAcquirePollerLock()) {
        if (s.leaderTimer) {
          clearInterval(s.leaderTimer);
          s.leaderTimer = null;
        }
        await beginPolling();
      }
    })();
  }, LEADER_RETRY_MS);
}

/** Stop polling and drop the singleton (so a new token takes effect). */
export async function stopBot(): Promise<void> {
  const s = botState();
  const bot = s.bot;
  // Give up poll leadership first so a standby (or our own restart) can re-poll.
  releasePollerLock();
  // Clear the singleton up front so a concurrent startBot() can't observe the
  // old instance, then stop the previous poller. Crucially we do NOT swallow a
  // stop() failure silently: if it throws, the old getUpdates loop keeps running
  // and would answer on the OLD token alongside the new bot — exactly the
  // "previous bot still works after switching" bug. Surface it loudly.
  s.bot = null;
  // Drop any in-flight build too, so a getBot() racing this stop can't resolve
  // afterwards and reinstate the old bot.
  s.botPromise = null;
  s.polling = false;
  s.token = "";
  if (bot) {
    try {
      await bot.stop();
      log.info("telegram polling stopped");
    } catch (e) {
      log.error("telegram bot.stop() failed — the old poller may still be running", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/** Apply a newly-saved token: fully stop the old bot, then start a fresh one. */
export async function restartBot(): Promise<void> {
  await stopBot();
  await startBot();
}

/**
 * Bind a Telegram account to the platform user that owns `code`. Shared by the
 * `/link CODE` command and the `t.me/<bot>?start=CODE` deep link (delivered as
 * `/start CODE`), so one-tap and manual linking run identical, throttled logic.
 */
async function linkAccount(ctx: Context, code: string): Promise<void> {
  // Throttle guessing attempts per Telegram user (defense-in-depth on top of
  // the large code space).
  if (!take(`tglink:${ctx.from!.id}`, 5).ok) {
    await reply(ctx, "tooManyAttempts");
    return;
  }

  const [lc] = await db.select().from(linkCodes).where(eq(linkCodes.code, code)).limit(1);
  if (!lc || lc.expiresAt < new Date()) {
    if (lc) await db.delete(linkCodes).where(eq(linkCodes.code, code));
    await reply(ctx, "invalidCode", { button: openAppButton() });
    return;
  }

  // This Telegram id may already be linked (re-running /link). The unique
  // constraint on telegram_user_id would otherwise throw with no reply —
  // re-point the existing link to the new account instead.
  const existing = await findLink(ctx.from!.id);
  if (existing) {
    await db
      .update(telegramLinks)
      .set({ userId: lc.userId, telegramUsername: ctx.from?.username || null, activeChatId: null })
      .where(eq(telegramLinks.id, existing.id));
  } else {
    await db.insert(telegramLinks).values({
      id: nanoid(),
      userId: lc.userId,
      telegramUserId: ctx.from!.id,
      telegramUsername: ctx.from?.username || null,
    });
  }
  // One Telegram account per platform user: if they just linked from a new
  // account (e.g. switching phones), drop any previous account so replies don't
  // start arriving from two identities into the same profile.
  await db
    .delete(telegramLinks)
    .where(and(eq(telegramLinks.userId, lc.userId), ne(telegramLinks.telegramUserId, ctx.from!.id)));
  // Mirror the binding into better-auth's account table so a later "Sign in with
  // Telegram" (OIDC) resolves to THIS user instead of minting a duplicate — the
  // two linking systems must agree on who owns a Telegram id. Account id is the
  // numeric Telegram id (what the OIDC id_token returns).
  await upsertTelegramAccountRow(lc.userId, ctx.from!.id);
  await db.delete(linkCodes).where(eq(linkCodes.code, code));
  await reply(ctx, "linked", { button: openChatButton() });
}

/**
 * Ensure a better-auth account row exists binding `telegramUserId` to `userId`,
 * and that no stale row binds that Telegram id to a different user. Tokenless —
 * better-auth fills tokens on the next OIDC sign-in; it only needs the
 * provider+accountId→user mapping to avoid creating a duplicate user.
 */
async function upsertTelegramAccountRow(userId: string, telegramUserId: number): Promise<void> {
  const accountId = String(telegramUserId);
  // Re-point any existing telegram account for this id (it may belong to a stale
  // duplicate); then guarantee one exists for this user.
  await db
    .delete(accounts)
    .where(and(eq(accounts.providerId, "telegram"), eq(accounts.accountId, accountId), ne(accounts.userId, userId)));
  const [mine] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.providerId, "telegram"), eq(accounts.accountId, accountId), eq(accounts.userId, userId)))
    .limit(1);
  if (!mine) {
    await db.insert(accounts).values({
      id: nanoid(),
      accountId,
      providerId: "telegram",
      userId,
    });
  }
}

async function findLink(telegramUserId: number) {
  const [link] = await db
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .limit(1);
  return link || null;
}
