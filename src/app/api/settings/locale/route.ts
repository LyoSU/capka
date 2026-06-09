import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireSession, apiHandler } from "@/lib/auth";
import { isLocale } from "@/i18n/config";

/** Set the signed-in user's interface language. Any authenticated user may
 *  change their own preference; it's read back per-request in `resolveLocale`. */
export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { locale } = await req.json();
  if (!isLocale(locale)) {
    return Response.json({ error: "Unsupported locale" }, { status: 400 });
  }
  await db.update(users).set({ locale }).where(eq(users.id, userId));
  return Response.json({ ok: true });
});
