import { eq, and, asc } from "drizzle-orm";
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
import { chatRequestSchema } from "@/lib/chat/contracts";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const body = chatRequestSchema.parse(await req.json());
  const { chatId: requestChatId, model: requestModel, projectId, userMessage, attachedFiles } = body;
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
    await Promise.all([
      db.insert(messages).values({
        id: nanoid(),
        chatId,
        role: "user",
        content: text,
        platform: "web",
      }).onConflictDoNothing(),
      db.update(chats).set({
        ...(isNewChat ? { title: text.slice(0, 100) } : {}),
        // Persist an explicit model switch so it sticks to this chat.
        ...(requestModel && requestModel !== existingChat?.model ? { model: requestModel } : {}),
        updatedAt: new Date(),
      }).where(eq(chats.id, chatId)),
    ]);
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

  await requireOwned(chats, chatId, userId, "Chat");

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt))
    .limit(100);

  return Response.json(toUIMessages(rows));
});
