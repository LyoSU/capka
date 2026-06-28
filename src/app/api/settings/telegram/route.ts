import { Bot } from "grammy";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { restartBot } from "@/lib/telegram/bot";

export const POST = apiHandler(async (req: Request) => {
  // Admin-only, always. Telegram is configured from Settings after onboarding —
  // it's never part of the first-run wizard — so an admin always exists by the
  // time this runs. The old "signed-in session is enough during setup" branch
  // let any registered account swap in its own bot token and hijack the
  // platform's Telegram channel during the setup window.
  await requireAdmin();

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

  // Save token (encrypted) plus the bot's @username (public, non-secret) so the
  // link UI can render a one-tap deep link for users of any role.
  await setSetting("telegram_bot_token", botToken.trim(), true);
  await setSetting("telegram_bot_username", botInfo.username ?? "", false);

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
