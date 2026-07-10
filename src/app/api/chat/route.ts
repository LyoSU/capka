import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireActive, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { reserveBudget, releaseHold } from "@/lib/billing/limits";
import { BudgetExceededError, ForbiddenError } from "@/lib/errors";
import { enqueueTask } from "@/lib/tasks/queue";
import type { TaskPayload } from "@/lib/tasks/runner";
import type { FileRef } from "@/lib/constants";
import { toUIMessages } from "@/lib/chat/presenter";
import { loadActivePath, switchSibling } from "@/lib/chat/tree";
import { chatRequestSchema } from "@/lib/chat/contracts";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  const ctx = await requireRole("admin", "user");
  // A pending (awaiting-approval) account must never reach the model — this is
  // the request that spends the shared key. The dashboard layout already keeps
  // them off the UI; this is the matching gate on the only key-spending route.
  if (ctx.status === "pending") {
    throw new ForbiddenError("Your account is awaiting administrator approval.");
  }
  const { userId } = ctx;

  // Cheap per-user flood guard (single-instance, in-memory). The client maps the
  // 429 to a friendly, localized message.
  const rl = take(`chat:${userId}`);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many messages — please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const body = chatRequestSchema.parse(await req.json());
  const { chatId: requestChatId, model: requestModel, projectId, userMessage, userMessageId, attachedFiles } = body;
  const chatId = requestChatId || nanoid();

  const [chatRow, project] = await Promise.all([
    requestChatId
      ? db.select({ id: chats.id, userId: chats.userId, title: chats.title, model: chats.model, source: chats.source }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0])
      : undefined,
    projectId
      ? db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1).then((r) => r[0])
      : Promise.resolve(undefined),
  ]);

  // IDOR: chat exists but belongs to another user
  if (chatRow && chatRow.userId !== userId) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }
  const existingChat = chatRow?.userId === userId ? chatRow : undefined;

  // Telegram chats are owned by the bot channel and read-only on the web — you
  // reply from Telegram, or fork the chat to take it over on the web. Block the
  // write server-side too (defense in depth beyond the disabled composer).
  if (existingChat?.source === "telegram") {
    return Response.json({ error: "This is a Telegram chat — reply from Telegram." }, { status: 403 });
  }

  // The chat's own model is the source of truth so the choice sticks across
  // reloads/turns; an explicit per-request model (user just switched) wins and
  // is persisted back onto the chat.
  const effectiveModel = requestModel ?? existingChat?.model ?? undefined;

  // Validate the provider/model up front so the user gets immediate feedback
  // instead of a task that fails in the background. The worker re-resolves it.
  const { isShared, modelId: resolvedModelId, provider: resolvedProvider } = await resolveUserModelInfo(userId, effectiveModel);

  // Budget gate: reserve an estimated hold for this turn up front, atomically.
  // The turn's own cost is counted before it runs (no single-turn free pass) and
  // concurrent turns across chats reserve against each other (no TOCTOU). Own-key
  // users are never gated; a shared-key turn on an unpriceable model fails closed.
  const taskId = nanoid();
  const reservation = await reserveBudget({
    userId, taskId, onSharedKey: isShared, modelId: resolvedModelId, provider: resolvedProvider,
  });
  if (!reservation.allowed) {
    throw new BudgetExceededError(reservation.window ?? "d30");
  }

  // The hold reserved above must be released on EVERY path that doesn't hand it to
  // a live turn — including an exception between here and enqueue. A failed
  // insert/update/enqueue would otherwise leak a pending hold that inflates the
  // budget forever (no task row exists for the zombie reconciler to clean up).
  let handedOff = false;
  try {
  if (!existingChat) {
    await db.insert(chats).values({
      id: chatId,
      userId,
      title: "New Chat",
      model: effectiveModel ?? null,
      projectId: project?.id ?? null,
    });
  }

  // Save user message + update chat title
  const text = userMessage || "";
  if (text) {
    const isNewChat = !existingChat || existingChat.title === "New Chat";
    const newUserId = userMessageId || nanoid();
    // The user message's parent is whatever it follows in the visible path the
    // client sent. Editing re-sends history ending at the *edited* message, so
    // this naturally makes the edit a sibling of the original — no deletes.
    const uiMsgs = body.messages ?? [];
    const selfIdx = uiMsgs.findIndex((m) => m.id === newUserId);
    const parentId = selfIdx > 0 ? uiMsgs[selfIdx - 1].id : null;
    // The parent comes from the client's view of the conversation; never trust
    // it blind. It must be a real message *in this chat* — otherwise a stale or
    // tampered client would 500 on the FK, or (with a real id from another
    // chat) silently graft this turn onto a foreign branch.
    if (parentId) {
      const [parent] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, parentId), eq(messages.chatId, chatId)))
        .limit(1);
      if (!parent) {
        // handedOff stays false → the finally below releases the hold.
        return Response.json({ error: "Conversation is out of date — please reload." }, { status: 409 });
      }
    }
    // Order matters: the message row must exist before the chat's
    // active_leaf_id can reference it (FK), so these can't run in parallel.
    await db.insert(messages).values({
      // Reuse the client's optimistic id so the rendered bubble keeps a stable
      // React key when history reloads — otherwise it remounts and flashes.
      id: newUserId,
      chatId,
      parentId,
      role: "user",
      content: text,
      platform: "web",
      // Persist what was attached so the history bubble can show it (reference
      // metadata only — the bytes stay in the sandbox workspace).
      metadata: attachedFiles?.length ? { attachedFiles } : null,
    }).onConflictDoNothing();
    await db.update(chats).set({
      ...(isNewChat ? { title: text.slice(0, 100) } : {}),
      // Persist an explicit model switch so it sticks to this chat.
      ...(requestModel && requestModel !== existingChat?.model ? { model: requestModel } : {}),
      // Point the chat at the new message so a reload mid-flight shows this
      // branch; the worker then advances it to the assistant reply.
      activeLeafId: newUserId,
      updatedAt: new Date(),
    }).where(eq(chats.id, chatId));
  }

  // Enqueue a durable task. The worker rebuilds model/tools/prompt from this
  // payload and runs it in the background — independent of this request.
  const payload: TaskPayload = {
    requestModel: effectiveModel,
    projectId: project?.id,
    uiMessages: body.messages || [],
    attachedFiles: attachedFiles as FileRef[] | undefined,
  };
  // Coalesces if the chat already has a pending turn (another tab/device, a
  // queued follow-up, a stale-after-failure resend) — the message we just
  // persisted folds into that turn instead of spawning a parallel one. The
  // returned id is the turn that will actually answer, so the client's stop
  // button targets a real, live turn rather than a phantom.
  const { id: turnId, created } = await enqueueTask({ id: taskId, chatId, userId, payload });
  // A created turn now OWNS this hold and reconciles it to the real cost at
  // finalize. A folded/raced turn (created=false) does not — the finally releases
  // our hold; the turn that actually answers carries its own.
  if (created) handedOff = true;

  // Return immediately — client syncs via SSE
  return Response.json({ taskId: turnId, chatId });
  } finally {
    if (!handedOff) await releaseHold(taskId);
  }
});

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  const chat = await requireOwned(chats, chatId, userId, "Chat");

  // The visible conversation is the active branch (root → active leaf), with
  // each node carrying its "‹ i/N ›" sibling position for the version switcher.
  const path = await loadActivePath(chatId, (chat.activeLeafId as string | null) ?? null);
  const rows = path.map((p) => ({ ...p.node, siblingIndex: p.siblingIndex, siblingCount: p.siblingCount }));

  return Response.json(toUIMessages(rows));
});

// PATCH /api/chat — flip the visible branch to the prev/next version of a
// message (the "‹ i/N ›" switcher), then descend to that branch's leaf.
export const PATCH = apiHandler(async (req: Request) => {
  // requireActive: block pending/rejected from mutating chat state (branch switch);
  // navigation of one's own chat stays open to viewers.
  const { userId } = await requireActive();
  const { chatId, messageId, direction } = (await req.json()) as {
    chatId?: string;
    messageId?: string;
    direction?: "prev" | "next";
  };
  if (!chatId || !messageId || (direction !== "prev" && direction !== "next")) {
    return Response.json({ error: "Missing chatId, messageId, or direction" }, { status: 400 });
  }

  await requireOwned(chats, chatId, userId, "Chat");

  const leafId = await switchSibling(chatId, messageId, direction);
  if (!leafId) return Response.json({ error: "No sibling in that direction" }, { status: 404 });
  return Response.json({ activeLeafId: leafId });
});
