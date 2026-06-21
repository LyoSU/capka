import { Bot, type Context } from "grammy";
import { nanoid } from "nanoid";
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramLinks, linkCodes, chats, messages, users, accounts } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { publishTaskEvent } from "@/lib/tasks/events";
import { enqueueTask } from "@/lib/tasks/queue";
import { resolveProviderConfig } from "@/lib/providers/resolve";
import { checkBudget } from "@/lib/billing/limits";
import { toUIMessages } from "@/lib/chat/presenter";
import { loadActivePath } from "@/lib/chat/tree";
import { take } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { getTranslator } from "@/lib/i18n/translator";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { uploadFile } from "@/lib/sandbox/client";
import type { FileRef } from "@/lib/constants";
import type { TaskPayload } from "@/lib/tasks/runner";

let _bot: Bot | null = null;
let _polling = false;
// Captured when the bot is built — needed to construct file download URLs
// (`https://api.telegram.org/file/bot<token>/<path>`), the one place the Bot API
// has no method wrapper for.
let _token = "";

const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024; // getFile's hard download cap

// The command menu Telegram shows behind the "/" hint. Registered under the
// default scope — English only, by design: the set is tiny and the menu is the
// one surface where per-locale upkeep isn't worth it (replies still localize to
// the user's client language).
const BOT_COMMANDS = [
  { command: "start", description: "Show the welcome message" },
  { command: "new", description: "Start a new chat" },
];

// Bot replies follow the user's own Telegram client language (falling back to
// English), so a user never has to configure anything to be understood.
const tFor = (ctx: Context) => getTranslator(ctx.from?.language_code, "telegram");

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
  const res = await fetch(`https://api.telegram.org/file/bot${_token}/${info.file_path}`);
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
  const t = tFor(ctx);
  const link = await findLink(ctx.from!.id);
  if (!link) {
    await ctx.reply(t("notLinked"));
    return;
  }
  // Approval gate: a pending account must not spend the shared key from Telegram
  // either — mirror the web /api/chat guard. (A Telegram login auto-links before
  // approval, so without this a pending user could DM the bot to slip past it.)
  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, link.userId)).limit(1);
  if (u?.status === "pending") {
    await ctx.reply(t("pendingApproval"));
    return;
  }
  // Same per-user flood guard as the web enqueue path.
  if (!take(`chat:${link.userId}`).ok) {
    await ctx.reply(t("tooFast"));
    return;
  }

  // Same shared-key budget gate as the web enqueue path — a user must not be able
  // to sidestep their spending limit by switching to Telegram.
  const config = await resolveProviderConfig(link.userId);
  const budget = await checkBudget(link.userId, config?.isShared ?? false);
  if (!budget.allowed) {
    await ctx.reply(t("budgetReached"));
    return;
  }

  // Route into the link's pinned Telegram chat — NOT "whatever the user last
  // touched on the web", which would mix Telegram replies into web/project
  // chats and lose project context.
  const title = (text || files[0]?.fileName || "Telegram Chat").slice(0, 100);
  const chat = await resolveActiveChat(link, title);
  const sessionKey = workspaceSessionKey({ id: chat.id, projectId: chat.projectId ?? null });

  // Pull each Telegram file into the user's sandbox so the assistant can read,
  // run or analyze it — passed through as attachedFiles, exactly like the web.
  const attachedFiles: FileRef[] = [];
  for (const f of files) {
    try {
      const file = await downloadTgFile(ctx, f);
      if (!file) {
        await ctx.reply(t("fileTooBig", { name: f.fileName }));
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
    await enqueueTask({ id: nanoid(), chatId: chat.id, userId: link.userId, payload });
    await ctx.replyWithChatAction("typing").catch(() => {});
  } catch (error: unknown) {
    await ctx.reply(t("startError", { error: error instanceof Error ? error.message : "Unknown error" }));
  }
}

export async function getBot(): Promise<Bot | null> {
  if (_bot) return _bot;
  const token = await getSetting("telegram_bot_token");
  if (!token) return null;

  _token = token;
  _bot = new Bot(token);

  // A bare /start greets; /start CODE is the deep-link path — tapping
  // `t.me/<bot>?start=CODE` in the web UI arrives here and links in one tap.
  _bot.command("start", async (ctx) => {
    const code = ctx.match?.trim().toUpperCase();
    if (code) {
      await linkAccount(ctx, code);
      return;
    }
    await ctx.reply(tFor(ctx)("start"));
  });

  _bot.command("link", async (ctx) => {
    const code = ctx.match?.trim().toUpperCase();
    if (!code) {
      await ctx.reply(tFor(ctx)("linkUsage"));
      return;
    }
    await linkAccount(ctx, code);
  });

  _bot.command("new", async (ctx) => {
    const t = tFor(ctx);
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await ctx.reply(t("linkFirst"));
      return;
    }
    const id = nanoid();
    await db
      .insert(chats)
      .values({ id, userId: link.userId, title: "Telegram Chat", source: "telegram" });
    await db.update(telegramLinks).set({ activeChatId: id }).where(eq(telegramLinks.id, link.id));
    await ctx.reply(t("newChat"));
  });

  // Plain text → straight into the engine.
  _bot.on("message:text", (ctx) => ingest(ctx, ctx.message.text, []));

  // Any message carrying a file the assistant can use: photo, document, video,
  // audio, voice, animation, video note. The caption is the prompt. Telegram
  // delivers an album (media group) as several updates sharing a
  // `media_group_id`, so we buffer those and ingest them as one turn.
  _bot.on(
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
  _bot.on("message", (ctx) => ctx.reply(tFor(ctx)("unsupported")).then(() => {}));

  // Without this, a throwing handler is either swallowed or crashes the polling
  // process depending on the runtime. Log it and keep the bot alive.
  _bot.catch((err) => {
    log.error("telegram handler error", { updateId: err.ctx.update.update_id, err: String(err.error) });
  });

  return _bot;
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
    await tx.insert(chats).values({ id, userId: link.userId, title: firstMessage || "Telegram Chat", source: "telegram" });
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
export async function startBot(): Promise<void> {
  if (_polling) return;
  const bot = await getBot();
  if (!bot) return;
  _polling = true;
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
}

/** Stop polling and drop the singleton (so a new token takes effect). */
export async function stopBot(): Promise<void> {
  const bot = _bot;
  // Clear the singleton up front so a concurrent startBot() can't observe the
  // old instance, then stop the previous poller. Crucially we do NOT swallow a
  // stop() failure silently: if it throws, the old getUpdates loop keeps running
  // and would answer on the OLD token alongside the new bot — exactly the
  // "previous bot still works after switching" bug. Surface it loudly.
  _bot = null;
  _polling = false;
  _token = "";
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
  const t = tFor(ctx);
  // Throttle guessing attempts per Telegram user (defense-in-depth on top of
  // the large code space).
  if (!take(`tglink:${ctx.from!.id}`, 5).ok) {
    await ctx.reply(t("tooManyAttempts"));
    return;
  }

  const [lc] = await db.select().from(linkCodes).where(eq(linkCodes.code, code)).limit(1);
  if (!lc || lc.expiresAt < new Date()) {
    if (lc) await db.delete(linkCodes).where(eq(linkCodes.code, code));
    await ctx.reply(t("invalidCode"));
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
  await ctx.reply(t("linked"));
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
