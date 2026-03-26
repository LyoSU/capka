import { eq } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { linkCodes, telegramLinks } from "@/lib/db/schema";

export const POST = apiHandler(async () => {
  const { userId } = await requireRole("admin", "user");

  const { randomInt } = await import("crypto");
  const code = String(randomInt(100000, 999999));
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
