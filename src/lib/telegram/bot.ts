import { Bot } from "grammy";
import { nanoid } from "nanoid";
import { eq, asc, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramLinks, linkCodes, chats, messages } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { publishTaskEvent } from "@/lib/tasks/events";
import { enqueueTask } from "@/lib/tasks/queue";
import { toUIMessages } from "@/lib/chat/presenter";
import type { TaskPayload } from "@/lib/tasks/runner";

let _bot: Bot | null = null;
let _polling = false;

export async function getBot(): Promise<Bot | null> {
  if (_bot) return _bot;
  const token = await getSetting("telegram_bot_token");
  if (!token) return null;

  _bot = new Bot(token);

  _bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to unClaw! Use /link CODE to connect your account.",
    );
  });

  _bot.command("link", async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply("Usage: /link CODE");
      return;
    }

    const [lc] = await db
      .select()
      .from(linkCodes)
      .where(eq(linkCodes.code, code))
      .limit(1);
    if (!lc || lc.expiresAt < new Date()) {
      if (lc) await db.delete(linkCodes).where(eq(linkCodes.code, code));
      await ctx.reply("Invalid or expired code.");
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
    await db.delete(linkCodes).where(eq(linkCodes.code, code));
    await ctx.reply("Account linked!");
  });

  _bot.command("new", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await ctx.reply("Link your account first with /link CODE");
      return;
    }
    const id = nanoid();
    await db
      .insert(chats)
      .values({ id, userId: link.userId, title: "Telegram Chat" });
    await db.update(telegramLinks).set({ activeChatId: id }).where(eq(telegramLinks.id, link.id));
    await ctx.reply("New chat started!");
  });

  _bot.on("message:text", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await ctx.reply("Account not linked. Use /link CODE");
      return;
    }

    // Route into the link's pinned Telegram chat — NOT "whatever the user last
    // touched on the web", which would mix Telegram replies into web/project
    // chats and lose project context.
    const chat = await resolveActiveChat(link, ctx.message.text.slice(0, 100));

    // Save user message
    await db.insert(messages).values({
      id: nanoid(),
      chatId: chat.id,
      role: "user",
      content: ctx.message.text,
      platform: "telegram",
      telegramMessageId: ctx.message.message_id,
    });
    await db
      .update(chats)
      .set({ updatedAt: new Date() })
      .where(eq(chats.id, chat.id));

    // Tell any open web client a message landed in this chat.
    await publishTaskEvent(link.userId, { type: "new_message", chatId: chat.id });

    // Run through the SAME durable engine as the web: build the conversation
    // from history and enqueue a task. The worker executes it (with memory,
    // project context, usage and the sandbox) and the runner pushes the reply
    // back to Telegram via the task origin — so it survives restarts and the
    // two channels can never drift.
    try {
      const rows = await db
        .select({
          id: messages.id, role: messages.role, content: messages.content,
          metadata: messages.metadata, createdAt: messages.createdAt, platform: messages.platform,
        })
        .from(messages)
        .where(eq(messages.chatId, chat.id))
        .orderBy(asc(messages.createdAt))
        .limit(100);

      const payload: TaskPayload = {
        requestModel: chat.model ?? undefined,
        projectId: chat.projectId ?? undefined,
        uiMessages: toUIMessages(rows),
        origin: { platform: "telegram", telegramChatId: ctx.chat.id },
      };
      await enqueueTask({ id: nanoid(), chatId: chat.id, userId: link.userId, payload });
      await ctx.replyWithChatAction("typing").catch(() => {});
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error occurred";
      await ctx.reply(`Couldn't start the assistant: ${msg}`);
    }
  });

  // Without this, a throwing handler is either swallowed or crashes the polling
  // process depending on the runtime. Log it and keep the bot alive.
  _bot.catch((err) => {
    console.error(`[telegram] handler error (update ${err.ctx.update.update_id}):`, err.error);
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
  const id = nanoid();
  await db.insert(chats).values({ id, userId: link.userId, title: firstMessage || "Telegram Chat" });
  await db.update(telegramLinks).set({ activeChatId: id }).where(eq(telegramLinks.id, link.id));
  const [c] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
  return c;
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
  // bot.start() resolves only when the bot stops, so never await it here.
  void bot.start({ onStart: (info) => console.log(`[telegram] polling as @${info.username}`) });
}

/** Stop polling and drop the singleton (so a new token takes effect). */
export async function stopBot(): Promise<void> {
  if (_bot && _polling) await _bot.stop().catch(() => {});
  _polling = false;
  _bot = null;
}

/** Apply a newly-saved token: stop the old bot, start a fresh one. */
export async function restartBot(): Promise<void> {
  await stopBot();
  await startBot();
}

async function findLink(telegramUserId: number) {
  const [link] = await db
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .limit(1);
  return link || null;
}
