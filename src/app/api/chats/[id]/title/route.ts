import { eq } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { loadActivePath } from "@/lib/chat/tree";
import { generateChatTitle } from "@/lib/chat/title";
import { resolveAuxTarget, resolveUserModelInfo } from "@/lib/providers/resolve";
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
 */
export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const chat = await requireOwned(chats, id, userId, "Chat");

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

  let spend: TokenUsage | undefined;
  const title = await generateChatTitle(target.model, target.provider, userText, assistantText, (u) => { spend = u; });

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
