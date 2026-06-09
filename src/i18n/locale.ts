import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getAuth } from "@/lib/auth";
import { defaultLocale, isLocale, matchAcceptLanguage, type Locale } from "./config";

/**
 * Resolve the active locale for the current request — never throws.
 *
 * Priority:
 *   1. Authenticated user's saved preference (`user.locale`).
 *   2. Anonymous visitor's browser `Accept-Language`.
 *   3. Default locale.
 *
 * This runs on every render via `getRequestConfig`, so it must tolerate a
 * not-yet-configured app (no master key, empty DB during setup): any failure
 * silently falls through to the header/default path.
 */
export async function resolveLocale(): Promise<Locale> {
  const h = await headers();

  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: h });
    const userId = session?.user?.id;
    if (userId) {
      const [row] = await db
        .select({ locale: users.locale })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (isLocale(row?.locale)) return row.locale;
    }
  } catch {
    // Setup not finished / DB unavailable — fall through to the header.
  }

  return matchAcceptLanguage(h.get("accept-language")) ?? defaultLocale;
}
