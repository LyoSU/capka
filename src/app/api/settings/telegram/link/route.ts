import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { linkCodes, telegramLinks } from "@/lib/db/schema";

export async function POST() {
  const { userId } = await requireSession();

  // Generate a cryptographically secure 6-digit code
  const { randomInt } = await import("crypto");
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Delete any existing codes for this user
  await db.delete(linkCodes).where(eq(linkCodes.userId, userId));

  await db.insert(linkCodes).values({ code, userId, expiresAt });

  return Response.json({ code, expiresAt: expiresAt.toISOString() });
}

export async function GET() {
  const { userId } = await requireSession();

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
}
