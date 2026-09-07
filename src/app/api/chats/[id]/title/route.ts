import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireWriter, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { loadActivePath } from "@/lib/chat/tree";
import { generateChatTitle } from "@/lib/chat/title";
import { resolveAuxTarget, resolveUserModelInfo } from "@/lib/providers/resolve";
import { reserveBudget, releaseHold } from "@/lib/billing/limits";
import { BudgetExceededError } from "@/lib/errors";
import { take } from "@/lib/rate-limit";
import { recordUsage } from "@/lib/usage";
import { publishTaskEvent } from "@/lib/tasks/events";
import { stripNul } from "@/lib/tasks/sanitize";
import type { TokenUsage } from "@/lib/pricing";

/**
 * Re-derive this chat's title from the conversation, on demand.
 *
 * The automatic pass in the runner fires exactly ONCE, on a chat's first completed
 * turn, and deliberately never fires again — that is what stops it clobbering a
 * title the owner typed by hand. So a conversation that wandered somewhere else
 * over twenty turns keeps the name its opening question earned, and there was no
 * way to ask for a fresh one. This route is that ask, and only that ask: it is
 * driven by an explicit user action, so it may overwrite a manual rename, and it
 * leaves the once-only auto rule untouched.
 *
 * Source text is the ACTIVE branch, not the whole tree — the same conversation the
 * user is looking at. A chat that has been forked or regenerated holds several
 * versions of the same exchange, and titling from an abandoned branch would name
 * the chat after something the reader cannot see.
 *
 * This route SPENDS: it calls a model, on the shared key when that is how the instance is
 * configured. So it carries the same two gates as `/api/chat` — a write-capable role
 * (`requireWriter`, which a read-only viewer fails) and a per-user flood guard plus an
 * atomic budget reservation — rather than the bare `requireSession` it used to hold, which
 * admitted a viewer and let any owner mint model calls past their cap by clicking a menu
 * item. Same helpers, deliberately, so there is one answer to "am I over the limit".
 */
export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireWriter();
  const { id } = await params;
  const chat = await requireOwned(chats, id, userId, "Chat");

  // Its own bucket, not the chat bucket: renaming must not consume the allowance for
  // sending messages, and being rate-limited on one must not silence the other.
  const rl = take(`title:${userId}`);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests — please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const path = await loadActivePath(id, (chat.activeLeafId as string | null) ?? null);
  const userText = path.find((e) => e.node.role === "user")?.node.content ?? "";
  // Last, not first: the point of regenerating is to catch up with where the
  // conversation went, and the opening reply is what the automatic pass already saw.
  const assistantText = [...path].reverse().find((e) => e.node.role === "assistant")?.node.content;

  // Nothing has been answered yet, so there is no conversation to name — the
  // placeholder /api/chat set from the opening message is still the best guess.
  // Distinct from "the model abstained" below, because the caller can act on it:
  // this one resolves itself by sending a message.
  if (!assistantText) {
    return Response.json({ error: "nothing_to_title" }, { status: 409 });
  }

  // The admin's background-work model when one is set and sits on the same key
  // pool, else this chat's own — the same rule the automatic title pass follows.
  const turn = await resolveUserModelInfo(userId, (chat.model as string | null) ?? undefined);
  const target = await resolveAuxTarget(userId, {
    model: turn.model, provider: turn.provider, modelId: turn.modelId,
    configId: turn.configId, isShared: turn.isShared,
  });

  // Reserve before calling the model, atomically and against the same windows a turn
  // reserves against — a hold, so two concurrent renames cannot both slip under the cap.
  // There is no task here, so the hold is keyed by an id minted for this request alone and
  // released in the `finally` below; the real cost lands as its own settled row.
  const holdId = nanoid();
  const reservation = await reserveBudget({
    userId, taskId: holdId, onSharedKey: target.isShared,
    modelId: target.modelId, provider: target.provider, configId: target.configId,
  });
  if (!reservation.allowed) {
    throw new BudgetExceededError(reservation.window ?? "m1");
  }

  let spend: TokenUsage | undefined;
  let title: string | null = null;
  try {
    title = await generateChatTitle(target.model, target.provider, userText, assistantText, (u) => { spend = u; });
  } finally {
    // Always: the hold was only ever a reservation for a call that is now over, and the
    // spend below is recorded independently of it. Leaving it behind would inflate this
    // user's budget forever — nothing reconciles a hold that has no task row.
    await releaseHold(holdId);
  }

  // Settled before the response, not fire-and-forget: unlike the runner's pass
  // there is no task to outlive the request, so anything deferred here would be
  // racing the serverless-style teardown of this handler. `recordUsage` never
  // throws, so a lost ledger line cannot cost the caller their title.
  if (spend) {
    await recordUsage({
      taskId: null, messageId: null, userId,
      provider: target.provider, configId: target.configId, model: target.modelId,
      onSharedKey: target.isShared, purpose: "title", usage: spend,
    });
  }

  // The model declined to name it (a greeting, or nothing left after sanitizing).
  // Keep the existing title rather than blanking a name that at least says
  // something, and tell the caller nothing changed.
  if (!title) return Response.json({ title: null });

  const next = stripNul(title);
  // No `updatedAt` bump, matching the runner: renaming a chat is not activity in
  // it, and bumping would jump the row into the sidebar's "today" group and
  // remount it under the user who just clicked a menu item.
  await db.update(chats).set({ title: next }).where(eq(chats.id, id));
  await publishTaskEvent(userId, { type: "chat:title", chatId: id, title: next });
  return Response.json({ title: next });
});
