import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { locales } from "@/i18n/config";
import { isValidTimezone } from "@/lib/timezone";
import { parseAgentProfile } from "@/lib/agents/profile";
import { getOrgAgentProfile } from "@/lib/settings";
import type { Control } from "../types";

const LOCALE_NAMES: Record<string, string> = { en: "English", uk: "Ukrainian" };

const locale: Control = {
  id: "user.locale",
  title: "Interface language",
  description: `Language of the interface and replies. Available: ${locales.join(", ")}.`,
  scope: "user",
  requiredRole: "user",
  risk: "safe",
  // Switching language re-renders the whole UI server-side (next-intl reads
  // user.locale per request), so the card refreshes the route on apply.
  reloadOnApply: true,
  // Valid set can't be read off a refined string, so declare it for the chip picker.
  options: [...locales],
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

/**
 * The user's own memory switch — the only bit of their agent profile exposed for
 * now (see users.agentProfile in db/schema.ts).
 *
 * Turning it off is always effective; turning it ON is only a request, because the
 * three profile layers fold by minimum and the org ceiling wins. Rather than
 * pretend otherwise, `impact` says so out loud when the admin has memory off
 * instance-wide — a switch that reports success and changes nothing is the exact
 * failure mode `sandbox_enabled` shipped with.
 */
const memory: Control = {
  id: "user.memory",
  title: "Remember things about me",
  description:
    "Whether the assistant keeps notes about you and your projects between conversations. Off means it neither reads nor writes them; existing notes are kept, just unused.",
  scope: "user",
  requiredRole: "user",
  risk: "safe",
  schema: z.enum(["true", "false"]),
  format: (v) => (v === "true" ? "On" : "Off"),
  read: async (ctx) => {
    const [row] = await db.select({ agentProfile: users.agentProfile }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    return String(parseAgentProfile(row?.agentProfile).capabilities.memory);
  },
  impact: async (_ctx, next) => {
    if (next !== "true") return undefined;
    const org = await getOrgAgentProfile();
    return org.capabilities.memory
      ? undefined
      : "Memory is currently off for the whole instance, so this will not take effect until an admin turns it back on.";
  },
  apply: async (ctx, v) => {
    const [row] = await db.select({ agentProfile: users.agentProfile }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    const current = parseAgentProfile(row?.agentProfile);
    await db
      .update(users)
      .set({ agentProfile: { ...current, capabilities: { ...current.capabilities, memory: v === "true" } } })
      .where(eq(users.id, ctx.userId));
  },
};

export const userControls: Control[] = [locale, timezone, memory];
