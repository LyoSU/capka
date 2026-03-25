import { Bot } from "grammy";
import { requireSession } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { generateSecret } from "@/lib/crypto";

export async function POST(req: Request) {
  await requireSession();

  const { botToken } = await req.json();
  if (!botToken?.trim()) {
    return Response.json({ error: "Missing bot token" }, { status: 400 });
  }

  // Validate token
  let botInfo;
  try {
    const bot = new Bot(botToken.trim());
    botInfo = await bot.api.getMe();
  } catch {
    return Response.json({ error: "Invalid bot token" }, { status: 400 });
  }

  // Save token (encrypted)
  await setSetting("telegram_bot_token", botToken.trim(), true);

  // Generate and save webhook secret
  const webhookSecret = generateSecret().slice(0, 32);
  await setSetting("telegram_webhook_secret", webhookSecret, true);

  // Register webhook with Telegram
  const baseUrl = process.env.BETTER_AUTH_URL || `${req.headers.get("x-forwarded-proto") || "https"}://${req.headers.get("host")}`;
  const webhookUrl = `${baseUrl}/api/webhook/telegram`;

  try {
    const bot = new Bot(botToken.trim());
    await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({
      ok: true,
      botUsername: botInfo.username,
      webhookUrl,
      warning: `Webhook registration failed: ${msg}. You may need to set it manually.`,
    });
  }

  return Response.json({
    ok: true,
    botUsername: botInfo.username,
    webhookUrl,
  });
}
