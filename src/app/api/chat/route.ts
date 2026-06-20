import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { enqueueTask } from "@/lib/tasks/queue";
import type { TaskPayload } from "@/lib/tasks/runner";
import type { FileRef } from "@/lib/constants";
import { toUIMessages } from "@/lib/chat/presenter";
import { loadActivePath, switchSibling } from "@/lib/chat/tree";
import { chatRequestSchema } from "@/lib/chat/contracts";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");

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
      ? db.select({ id: chats.id, userId: chats.userId, title: chats.title, model: chats.model }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0])
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

  // The chat's own model is the source of truth so the choice sticks across
  // reloads/turns; an explicit per-request model (user just switched) wins and
  // is persisted back onto the chat.
  const effectiveModel = requestModel ?? existingChat?.model ?? undefined;

  // Validate the provider/model up front so the user gets immediate feedback
  // instead of a task that fails in the background. The worker re-resolves it.
  await resolveUserModelInfo(userId, effectiveModel);

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
  const taskId = nanoid();
  const payload: TaskPayload = {
    requestModel: effectiveModel,
    projectId: project?.id,
    uiMessages: body.messages || [],
    attachedFiles: attachedFiles as FileRef[] | undefined,
  };
  await enqueueTask({ id: taskId, chatId, userId, payload });

  // Return immediately — client syncs via SSE
  return Response.json({ taskId, chatId });
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
  const { userId } = await requireSession();
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
