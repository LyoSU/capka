import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { Bot } from "grammy";
import { getAuth } from "@/lib/auth";
import { setSetting, getSetting } from "@/lib/settings";
import { generateSecret } from "@/lib/crypto";

export async function POST(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { botToken } = await req.json();
  if (!botToken?.trim()) {
    return NextResponse.json({ error: "Missing bot token" }, { status: 400 });
  }

  // Validate token
  let botInfo;
  try {
    const bot = new Bot(botToken.trim());
    botInfo = await bot.api.getMe();
  } catch {
    return NextResponse.json({ error: "Invalid bot token" }, { status: 400 });
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
    return NextResponse.json(
      { error: `Token saved but webhook registration failed: ${msg}. You may need to set it manually.` },
      { status: 207 },
    );
  }

  return NextResponse.json({
    ok: true,
    botUsername: botInfo.username,
    webhookUrl,
  });
}
