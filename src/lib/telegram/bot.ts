import { Bot, webhookCallback } from "grammy";
import { nanoid } from "nanoid";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramLinks, linkCodes, chats, messages } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { eventBus } from "@/lib/events";

let _bot: Bot | null = null;

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

    await db.insert(telegramLinks).values({
      id: nanoid(),
      userId: lc.userId,
      telegramUserId: ctx.from!.id,
      telegramUsername: ctx.from?.username || null,
    });
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
    await ctx.reply("New chat started!");
  });

  _bot.on("message:text", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await ctx.reply("Account not linked. Use /link CODE");
      return;
    }

    // Find or create chat
    let [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, link.userId))
      .orderBy(desc(chats.updatedAt))
      .limit(1);
    if (!chat) {
      const id = nanoid();
      await db.insert(chats).values({
        id,
        userId: link.userId,
        title: ctx.message.text.slice(0, 100),
      });
      [chat] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
    }

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

    // Emit SSE event for real-time sync
    eventBus.emit(`user:${link.userId}`, {
      type: "new_message",
      chatId: chat.id,
    });

    try {
      const { processMessageForTelegram } = await import("./agent-handler");
      const response = await processMessageForTelegram(
        link.userId,
        chat.id,
        ctx.message.text,
      );

      await db.insert(messages).values({
        id: nanoid(),
        chatId: chat.id,
        role: "assistant",
        content: response,
        platform: "telegram",
      });
      eventBus.emit(`user:${link.userId}`, {
        type: "new_message",
        chatId: chat.id,
      });
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Unknown error occurred";
      await ctx.reply(`Error: ${msg}`);
    }
  });

  return _bot;
}

async function findLink(telegramUserId: number) {
  const [link] = await db
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .limit(1);
  return link || null;
}

export async function getWebhookHandler() {
  const bot = await getBot();
  if (!bot) return null;
  return webhookCallback(bot, "std/http");
}
