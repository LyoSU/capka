import { eq } from "drizzle-orm";
import { requireRole, apiHandler, unlinkTelegramIdentity } from "@/lib/auth";
import { db } from "@/lib/db";
import { linkCodes, telegramLinks } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";

export const POST = apiHandler(async () => {
  const { userId } = await requireRole("admin", "user");

  // 8 chars from an unambiguous alphabet (no 0/O/1/I/L) — ~31^8 ≈ 8e11
  // possibilities, so the code can't be brute-forced in the 5-minute window
  // (the old 6-digit space was only 9e5).
  const { randomInt } = await import("crypto");
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(0, ALPHABET.length)];
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db.delete(linkCodes).where(eq(linkCodes.userId, userId));
  await db.insert(linkCodes).values({ code, userId, expiresAt });

  return Response.json({ code, expiresAt: expiresAt.toISOString() });
});

export const GET = apiHandler(async () => {
  const { userId } = await requireRole("admin", "user");

  const [link] = await db
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId))
    .limit(1);

  // Public, non-secret — lets the link UI build the t.me deep link / QR for any
  // role without touching the admin-only token read.
  const botUsername = await getSetting("telegram_bot_username");

  return Response.json({
    linked: !!link,
    username: link?.telegramUsername || null,
    linkedAt: link?.linkedAt?.toISOString() || null,
    botUsername: botUsername || null,
  });
});

// Unlink the caller's Telegram account so they can connect a different one.
// Revokes the delivery link, any pending link code, AND the login identity
// (see unlinkTelegramIdentity) so the old Telegram account can't still sign in.
export const DELETE = apiHandler(async () => {
  const { userId } = await requireRole("admin", "user");
  await unlinkTelegramIdentity(userId);
  return Response.json({ ok: true });
});
