import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { requireRole, apiHandler } from "@/lib/auth";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { createImportedChat } from "@/lib/chat/tree";
import { normalizeImport, MAX_IMPORT_MESSAGES, MAX_IMPORT_MESSAGE_CHARS } from "@/lib/import";
import { sourceLabel } from "@/lib/import/detect";
import { isShareImportEnabled } from "@/lib/import/flag";
import { take } from "@/lib/rate-limit";

const schema = z.object({
  source: z.enum(["claude", "chatgpt", "gemini", "grok"]),
  title: z.string().max(1000).nullable().optional(),
  // The model the user has selected — the imported chat adopts it so their next
  // turn runs on the model they picked here, not a stale default.
  model: z.string().nullable().optional(),
  // Idempotency key minted by the client on a successful preview. A repeated
  // commit with the same key (retry after a lost response, double-click) returns
  // the already-created chat instead of duplicating it.
  key: z.string().min(8).max(64).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        // Bound each message before it's buffered/normalized — a tampered payload
        // shouldn't be able to stream unbounded text at the server. The +8 leaves
        // room for the clip marker normalizeImport may append.
        content: z.string().max(MAX_IMPORT_MESSAGE_CHARS + 8),
      }),
    )
    .max(MAX_IMPORT_MESSAGES),
});

// Idempotency cache: `${userId}:${key}` → the chat that commit already created.
// In-memory is fine — the platform runs as a single process by design. Entries
// expire after 15 min and are swept lazily on access.
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const recentCommits = new Map<string, { chatId: string; exp: number }>();

/**
 * Create a new chat from a previewed import. The messages come from the client's
 * preview round-trip; we re-run `normalizeImport` here so the caps and sanitize
 * are enforced server-side regardless — the commit never trusts the client's copy
 * (though the worst a tampered payload could do is put text into the caller's own
 * private chat, which carries no privilege anyway).
 */
export const POST = apiHandler(async (req: Request) => {
  if (!isShareImportEnabled()) throw new NotFoundError();
  const { userId } = await requireRole("admin", "user");

  // Commit is cheap (no headless Chromium) so it's more liberal than preview,
  // but still bounded so a script can't hammer chat creation.
  const rl = take(`share-import-commit:${userId}`, 5, 1 / 5);
  if (!rl.ok) return Response.json({ error: "Too many imports — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  // Reject an oversized body before reading it. A normalized import is ≤600k
  // chars (~1.2 MB of UTF-8 JSON); 4 MB is a generous ceiling that still stops
  // the ~20 MB the zod schema alone would otherwise let req.json() buffer.
  if (Number(req.headers.get("content-length")) > 4 * 1024 * 1024) {
    return Response.json({ error: "Import payload too large." }, { status: 413 });
  }

  const body = schema.parse(await req.json());

  const cacheKey = body.key ? `${userId}:${body.key}` : null;
  if (cacheKey) {
    const now = Date.now();
    for (const [k, v] of recentCommits) if (v.exp <= now) recentCommits.delete(k);
    const hit = recentCommits.get(cacheKey);
    if (hit) return Response.json({ id: hit.chatId }, { status: 201 });
  }

  const normalized = normalizeImport({
    source: body.source,
    title: body.title ?? null,
    messages: body.messages,
    truncated: false,
    droppedRichContent: false,
  });
  if (normalized.messages.length === 0) throw new ValidationError("Nothing to import");

  // Localize the fallback title in the user's locale rather than persisting an
  // English literal for everyone (reuse the offer's "{service} conversation").
  const t = await getTranslations("chat.import");
  const title = normalized.title || t("untitled", { service: sourceLabel(body.source) });

  const chatId = await createImportedChat({
    userId,
    model: body.model ?? null,
    title,
    messages: normalized.messages,
    importSource: body.source,
  });

  if (cacheKey) recentCommits.set(cacheKey, { chatId, exp: Date.now() + IDEMPOTENCY_TTL_MS });

  return Response.json({ id: chatId }, { status: 201 });
});
