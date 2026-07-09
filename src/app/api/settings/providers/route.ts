import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getMasterKey, ownKeysAllowed } from "@/lib/settings";
import { ForbiddenError } from "@/lib/errors";
import { PROVIDERS } from "@/lib/providers";
import { invalidateModelsCache } from "@/lib/providers/list-models";

// "auto" is the stored-as-null default — only an explicit override is persisted.
// Anything unrecognised is treated as no override (null), never trusted blindly.
function normalizeApiStyle(value: unknown): string | null {
  return value === "chat" || value === "responses" ? value : null;
}

// Validate a custom base URL's FORMAT at write time (catch typos / reject non-http
// schemes early). The SSRF policy (private-range blocking, DNS) is still enforced at
// USE time via assertSafeProviderConfig — that's the security boundary; this is UX
// so a bad URL fails on save, not mid-stream. Empty/absent is allowed (optional).
function validBaseUrl(value: unknown): boolean {
  if (!value) return true;
  try {
    const p = new URL(String(value)).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();

  const rows = await db
    .select({
      id: providerConfigs.id,
      provider: providerConfigs.provider,
      baseUrl: providerConfigs.baseUrl,
      defaultModel: providerConfigs.defaultModel,
      isActive: providerConfigs.isActive,
      shared: providerConfigs.shared,
      label: providerConfigs.label,
      iconSlug: providerConfigs.iconSlug,
      apiStyle: providerConfigs.apiStyle,
      createdAt: providerConfigs.createdAt,
    })
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, userId))
    .orderBy(providerConfigs.sortOrder, providerConfigs.createdAt);

  return Response.json(rows);
});

export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireRole("admin", "user");

  // In shared_only, regular users may not add their own key — the admin's shared
  // key is the only one. Admins always may (they configure that shared key here).
  if (role !== "admin" && !(await ownKeysAllowed())) {
    throw new ForbiddenError("Adding your own provider key is disabled on this instance.");
  }

  const { provider, apiKey, baseUrl, defaultModel, label, iconSlug, shared, apiStyle } = await req.json();
  if (!provider || !PROVIDERS.includes(provider)) {
    return Response.json({ error: "Invalid or missing provider" }, { status: 400 });
  }
  if (!validBaseUrl(baseUrl)) {
    return Response.json({ error: "Base URL must be a valid http(s) URL." }, { status: 400 });
  }

  const masterKey = await getMasterKey();
  const encryptedKey = apiKey ? encrypt(apiKey, masterKey) : null;

  // Several configs can be enabled at once (the picker aggregates them), so a
  // new one is simply added enabled — it no longer disables the others.
  const id = nanoid();
  // Append after the user's existing connections in their chosen order.
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${providerConfigs.sortOrder}), -1) + 1` })
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, userId));
  await db.insert(providerConfigs).values({
    id,
    userId,
    provider,
    apiKey: encryptedKey,
    baseUrl: baseUrl || null,
    defaultModel: defaultModel || null,
    isActive: true,
    shared: shared === false ? false : true,
    label: label?.trim() || null,
    iconSlug: iconSlug || null,
    // Only meaningful for the openai provider; harmless null elsewhere.
    apiStyle: provider === "openai" ? normalizeApiStyle(apiStyle) : null,
    sortOrder: next,
  });

  invalidateModelsCache();
  return Response.json({ id, provider, defaultModel, isActive: true });
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { id, defaultModel, enabled, label, iconSlug, shared, apiStyle, order } = await req.json();

  // Reorder: an ordered list of the caller's OWN config ids. Every id must
  // belong to the caller and the list must cover exactly their configs — so a
  // request can never touch, or leave gaps against, someone else's rows. Assign
  // sortOrder by position; the picker then follows this order.
  if (Array.isArray(order)) {
    if (order.some((x) => typeof x !== "string")) {
      return Response.json({ error: "Invalid order" }, { status: 400 });
    }
    const owned = await db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(eq(providerConfigs.userId, userId));
    const ownedIds = new Set(owned.map((r) => r.id));
    const orderIds = order as string[];
    const sameSize = orderIds.length === ownedIds.size;
    const allOwned = orderIds.every((x) => ownedIds.has(x));
    const noDupes = new Set(orderIds).size === orderIds.length;
    if (!sameSize || !allOwned || !noDupes) {
      return Response.json({ error: "Order must list exactly your connections" }, { status: 400 });
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderIds.length; i++) {
        await tx
          .update(providerConfigs)
          .set({ sortOrder: i })
          .where(and(eq(providerConfigs.id, orderIds[i]), eq(providerConfigs.userId, userId)));
      }
    });
    invalidateModelsCache();
    return Response.json({ ok: true });
  }

  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  // Toggle a single config's enabled state — others are left untouched, since
  // any number may be enabled together.
  if (typeof enabled === "boolean") {
    const [updated] = await db
      .update(providerConfigs)
      .set({ isActive: enabled })
      .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)))
      .returning();
    if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
    invalidateModelsCache();
    return Response.json({ id: updated.id, isActive: updated.isActive });
  }

  // Patch whichever editable fields the request carries (default model, custom
  // name, custom glyph).
  const set: Partial<typeof providerConfigs.$inferInsert> = {};
  if (defaultModel !== undefined) set.defaultModel = defaultModel || null;
  if (label !== undefined) set.label = label?.trim() || null;
  if (iconSlug !== undefined) set.iconSlug = iconSlug || null;
  if (typeof shared === "boolean") set.shared = shared;
  if (apiStyle !== undefined) set.apiStyle = normalizeApiStyle(apiStyle);
  if (Object.keys(set).length === 0) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const [updated] = await db
    .update(providerConfigs)
    .set(set)
    .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)))
    .returning();

  if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
  invalidateModelsCache();
  return Response.json({ id: updated.id, defaultModel: updated.defaultModel, label: updated.label, iconSlug: updated.iconSlug });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await db
    .delete(providerConfigs)
    .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)));

  invalidateModelsCache();
  return Response.json({ ok: true });
});
