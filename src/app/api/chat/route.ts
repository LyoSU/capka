import { eq, and, asc, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole } from "@/lib/auth";
import { isAppError, type AppError } from "@/lib/errors";
import { db } from "@/lib/db";
import { chats, messages, projects, memories, tasks } from "@/lib/db/schema";
import { resolveUserModel } from "@/lib/providers/resolve";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { startTask } from "@/lib/tasks/runner";
import type { FileRef } from "@/lib/constants";
import { toUIMessages } from "@/lib/chat/presenter";
import { buildSystemPrompt, classifyFiles } from "@/lib/chat/prompt";

export async function POST(req: Request) {
  let mcpClose: (() => Promise<void>) | undefined;
  try {
    const { userId } = await requireRole("admin", "user");
    const body = await req.json();
    const { chatId: requestChatId, model: requestModel, projectId, userMessage, attachedFiles } = body;
    const chatId = requestChatId || nanoid();

    const [chatRow, model, project, userMemories] = await Promise.all([
      requestChatId
        ? db.select({ id: chats.id, userId: chats.userId, title: chats.title }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0])
        : undefined,
      resolveUserModel(userId, requestModel),
      projectId
        ? db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1).then((r) => r[0])
        : Promise.resolve(undefined),
      db.select().from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.createdAt)).limit(50),
    ]);

    const mcp = await loadSandboxTools(userId, chatId, project?.sandboxNetwork ?? undefined);
    mcpClose = mcp.close;

    // IDOR: chat exists but belongs to another user
    if (chatRow && chatRow.userId !== userId) {
      await mcpClose();
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }
    const existingChat = chatRow?.userId === userId ? chatRow : undefined;

    if (!existingChat) {
      await db.insert(chats).values({
        id: chatId,
        userId,
        title: "New Chat",
        model: requestModel,
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
          updatedAt: new Date(),
        }).where(eq(chats.id, chatId)),
      ]);
    }

    // Workspace snapshot — NOTE: execCommand runs inside isolated Docker container, not on host
    let workspaceSnapshot: string | undefined;
    try {
      const { execCommand: sandboxExec } = await import("@/lib/sandbox/client");
      const ws = await sandboxExec(chatId, "find /workspace -maxdepth 3 -not -path '*/\\.*' | head -50", 5000).catch(() => null);
      if (ws?.stdout?.trim()) workspaceSnapshot = ws.stdout.trim();
    } catch { /* sandbox not ready yet */ }

    const fileList = attachedFiles as FileRef[] | undefined;
    const { nativeFiles } = classifyFiles(fileList);
    const systemPrompt = buildSystemPrompt({
      project,
      memories: userMemories,
      workspaceSnapshot,
      attachedFiles: fileList,
    });

    // Create task and start background execution
    const taskId = nanoid();
    await db.insert(tasks).values({ id: taskId, chatId, userId });

    startTask({
      taskId,
      chatId,
      userId,
      model,
      tools: mcp.tools,
      systemPrompt,
      uiMessages: body.messages || [],
      closeMcp: mcpClose!,
      existingMemories: userMemories,
      nativeFiles: nativeFiles.length > 0 ? nativeFiles : undefined,
    });

    // Return immediately — client syncs via SSE
    return Response.json({ taskId, chatId });
  } catch (e: unknown) {
    await mcpClose?.();
    if (isAppError(e)) return (e as AppError).toResponse();
    console.error("[chat]", e);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const { userId } = await requireSession();

  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  const [chat] = await db.select({ id: chats.id }).from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt))
    .limit(100);

  return Response.json(toUIMessages(rows));
}
