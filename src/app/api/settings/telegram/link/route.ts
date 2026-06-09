import { eq } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { linkCodes, telegramLinks } from "@/lib/db/schema";

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

  return Response.json({
    linked: !!link,
    username: link?.telegramUsername || null,
    linkedAt: link?.linkedAt?.toISOString() || null,
  });
});
