import { eq } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { messages, chats } from "@/lib/db/schema";
import { resolveConfigById } from "@/lib/providers/resolve";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import type { MessageMeta } from "@/lib/chat/contracts";

/**
 * Lazy detail feed for the assistant (i) popover: OpenRouter's per-generation
 * stats (latency, the real provider chain, cache discount, native token counts).
 * Pulled on demand when a human opens the popover — never at finalize, because
 * the GET /generation record lands a beat after the stream ends and almost no
 * message is ever inspected. By click time it's ready.
 *
 * Only OpenRouter turns carry a `gen-…` id; everything else returns
 * `available:false` so the client simply omits the section. We bill the lookup to
 * the SAME config the turn ran on (stored as `configId`), so a shared-key turn
 * uses the admin key and an own-key turn the user's — matching who can actually
 * see the generation on OpenRouter's side.
 */
export const GET = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;

  // Ownership: the message must live in a chat this user owns. One join, and we
  // grab the metadata in the same round-trip.
  const [row] = await db
    .select({ metadata: messages.metadata, ownerId: chats.userId })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(eq(messages.id, id))
    .limit(1);
  if (!row || row.ownerId !== userId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const meta = (row.metadata ?? {}) as MessageMeta;
  if (!meta.generationId || !meta.configId) {
    return Response.json({ available: false });
  }

  // Re-resolve the exact key the turn was billed to (own first, then a shared
  // admin key when sharing is on). A removed/rotated config just yields no stats.
  const config = await resolveConfigById(userId, meta.configId);
  if (!config?.apiKey) return Response.json({ available: false });
  const apiKey = decrypt(config.apiKey, await getMasterKey());

  // The OpenRouter generation endpoint is first-party (fixed host) — no SSRF
  // surface to guard. No timeout dance: it's a tiny metadata GET.
  let res: Response;
  try {
    res = await fetch(
      `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(meta.generationId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    return Response.json({ available: false });
  }

  // 404 = the record hasn't propagated yet (a click within ~1s of finishing).
  // Tell the client to retry shortly rather than treating it as "no data".
  if (res.status === 404) return Response.json({ available: false, pending: true });
  if (!res.ok) return Response.json({ available: false });

  const { data } = (await res.json()) as { data?: Record<string, unknown> };
  if (!data) return Response.json({ available: false });

  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

  // The provider chain: each attempt OpenRouter made (a fallback shows >1 entry).
  const responses = Array.isArray(data.provider_responses) ? data.provider_responses : [];
  const chain = responses
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return { provider: str(o.provider_name), latencyMs: num(o.latency), status: num(o.status) };
    })
    .filter((r) => r.provider || r.latencyMs != null);

  // A curated subset — only fields the popover renders, never the raw upstream
  // ids or referer. Cost stays admin-gated client-side, like the message cost.
  return Response.json(
    {
      available: true,
      provider: str(data.provider_name),
      latencyMs: num(data.latency),
      generationMs: num(data.generation_time),
      moderationMs: num(data.moderation_latency),
      cacheDiscount: num(data.cache_discount),
      finishReason: str(data.native_finish_reason) ?? str(data.finish_reason),
      cancelled: typeof data.cancelled === "boolean" ? data.cancelled : undefined,
      nativeTokens: {
        prompt: num(data.native_tokens_prompt),
        completion: num(data.native_tokens_completion),
        reasoning: num(data.native_tokens_reasoning),
        cached: num(data.native_tokens_cached),
      },
      totalCost: num(data.total_cost),
      upstreamCost: num(data.upstream_inference_cost),
      isByok: typeof data.is_byok === "boolean" ? data.is_byok : undefined,
      chain,
    },
    // Per-user, immutable once settled — let the browser keep it for the session.
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
});
