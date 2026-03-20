import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { linkCodes, telegramLinks } from "@/lib/db/schema";

export async function POST() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const userId = session.user.id;

  // Generate a 6-digit code
  const code = Math.random().toString(10).slice(2, 8).padStart(6, "0");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Delete any existing codes for this user
  await db.delete(linkCodes).where(eq(linkCodes.userId, userId));

  await db.insert(linkCodes).values({ code, userId, expiresAt });

  return Response.json({ code, expiresAt: expiresAt.toISOString() });
}

export async function GET() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const userId = session.user.id;

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
