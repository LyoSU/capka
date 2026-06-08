import { Bot } from "grammy";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { setSetting, isSetupComplete } from "@/lib/settings";
import { restartBot } from "@/lib/telegram/bot";

export const POST = apiHandler(async (req: Request) => {
  // During setup wizard, user isn't admin yet — allow if setup not complete
  const setupDone = await isSetupComplete();
  if (setupDone) await requireAdmin();

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

  // Start (or restart) long-polling with the new token — no public webhook
  // URL needed, so this works behind NAT/firewalls out of the box.
  try {
    await restartBot();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({
      ok: true,
      botUsername: botInfo.username,
      warning: `Saved, but couldn't start the bot: ${msg}. Restarting the server will retry.`,
    });
  }

  return Response.json({ ok: true, botUsername: botInfo.username });
});
