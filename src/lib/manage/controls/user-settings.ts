import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { locales } from "@/i18n/config";
import type { Control } from "../types";

/** Validate an IANA timezone the same way the /settings/timezone route does —
 *  Intl throws on anything it doesn't recognise. */
function isValidTimezone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const LOCALE_NAMES: Record<string, string> = { en: "English", uk: "Ukrainian" };

const locale: Control = {
  id: "user.locale",
  title: "Interface language",
  description: `Language of the interface and replies. Available: ${locales.join(", ")}.`,
  scope: "user",
  requiredRole: "user",
  risk: "safe",
  schema: z.string().refine((v) => (locales as readonly string[]).includes(v), "Unsupported language."),
  format: (v) => LOCALE_NAMES[v] ?? v,
  read: async (ctx) =>
    (await db.select({ locale: users.locale }).from(users).where(eq(users.id, ctx.userId)).limit(1))[0]?.locale ?? "en",
  apply: async (ctx, v) => {
    await db.update(users).set({ locale: v }).where(eq(users.id, ctx.userId));
  },
};

const timezone: Control = {
  id: "user.timezone",
  title: "Time zone",
  description: 'Your IANA time zone (e.g. "Europe/Kyiv"). The agent uses it for dates in the conversation.',
  scope: "user",
  requiredRole: "user",
  risk: "safe",
  schema: z.string().refine(isValidTimezone, "Invalid time zone."),
  read: async (ctx) =>
    (await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, ctx.userId)).limit(1))[0]?.timezone ??
    "UTC",
  apply: async (ctx, v) => {
    await db.update(users).set({ timezone: v }).where(eq(users.id, ctx.userId));
  },
};

export const userControls: Control[] = [locale, timezone];
