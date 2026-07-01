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

const locale: Control = {
  id: "user.locale",
  title: "Мова інтерфейсу",
  description: `Мова інтерфейсу й відповідей. Доступні: ${locales.join(", ")}.`,
  scope: "user",
  requiredRole: "user",
  risk: "safe",
  schema: z.string().refine((v) => (locales as readonly string[]).includes(v), "Непідтримувана мова."),
  read: async (ctx) =>
    (await db.select({ locale: users.locale }).from(users).where(eq(users.id, ctx.userId)).limit(1))[0]?.locale ?? "en",
  apply: async (ctx, v) => {
    await db.update(users).set({ locale: v }).where(eq(users.id, ctx.userId));
  },
};

const timezone: Control = {
  id: "user.timezone",
  title: "Часовий пояс",
  description: 'Ваш IANA-часовий пояс (наприклад, "Europe/Kyiv"). Агент використовує його для дат у розмові.',
  scope: "user",
  requiredRole: "user",
  risk: "safe",
  schema: z.string().refine(isValidTimezone, "Некоректний часовий пояс."),
  read: async (ctx) =>
    (await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, ctx.userId)).limit(1))[0]?.timezone ??
    "UTC",
  apply: async (ctx, v) => {
    await db.update(users).set({ timezone: v }).where(eq(users.id, ctx.userId));
  },
};

export const userControls: Control[] = [locale, timezone];
