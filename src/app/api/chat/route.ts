import { eq, and, asc, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, projects, memories, tasks } from "@/lib/db/schema";
import { resolveUserModel } from "@/lib/providers/resolve";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { SYSTEM_PROMPT, SANDBOX_PROMPT } from "@/lib/agents/chat-agent";
import { startTask } from "@/lib/tasks/runner";

export async function POST(req: Request) {
  let mcpClose: (() => Promise<void>) | undefined;
  try {
    const { userId } = await requireSession();
    const body = await req.json();
    const { chatId: requestChatId, model: requestModel, projectId, userMessage } = body;
    const chatId = requestChatId || nanoid();

    const [chatRow, model, mcp, project, userMemories] = await Promise.all([
      requestChatId
        ? db.select({ id: chats.id, userId: chats.userId, title: chats.title }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0])
        : undefined,
      resolveUserModel(userId, requestModel),
      loadSandboxTools(userId, chatId),
      projectId
        ? db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1).then((r) => r[0])
        : Promise.resolve(undefined),
      db.select().from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.createdAt)).limit(50),
    ]);

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

    // Build system prompt
    let systemPrompt = `${SYSTEM_PROMPT}\n\n${SANDBOX_PROMPT}`;
    if (project?.systemPrompt) {
      systemPrompt += `\n\n--- Project Instructions ---\n${project.systemPrompt}`;
    }
    if (userMemories.length > 0) {
      const memoryLines = userMemories.map((m) => `- ${m.content}`).join("\n");
      systemPrompt += `\n\n## Things you know about the user:\n${memoryLines}`;
    }

    // Inject workspace snapshot so AI knows what files exist without extra ls calls
    // NOTE: execCommand runs inside isolated Docker container, not on host
    try {
      const { execCommand: sandboxExec } = await import("@/lib/sandbox/client");
      const ws = await sandboxExec(chatId, "find /workspace -maxdepth 3 -not -path '*/\\.*' | head -50", 5000).catch(() => null);
      if (ws?.stdout?.trim()) {
        systemPrompt += `\n\n## Current workspace files:\n\`\`\`\n${ws.stdout.trim()}\n\`\`\``;
      }
    } catch { /* sandbox not ready yet */ }

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
    });

    // Return immediately — client syncs via SSE
    return Response.json({ taskId, chatId });
  } catch (e: unknown) {
    await mcpClose?.();
    if (e instanceof Response) return e;
    console.error("[chat] Unexpected error:", e);
    const msg = e instanceof Error ? e.message : "An unexpected error occurred";
    return Response.json({ error: msg }, { status: 500 });
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

  type ToolMeta = {
    status?: string;
    toolCalls?: { id: string; name: string; input: unknown }[];
    toolResults?: { id: string; name: string; output: unknown }[];
  };

  const uiMessages = rows.map((m) => {
    const meta = m.metadata as ToolMeta | null;
    const parts: unknown[] = [];

    if (meta?.toolCalls) {
      const resultMap = new Map(meta.toolResults?.map((tr) => [tr.id, tr]) ?? []);
      for (const tc of meta.toolCalls) {
        const tr = resultMap.get(tc.id);
        parts.push({
          type: "dynamic-tool",
          toolCallId: tc.id,
          toolName: tc.name,
          state: tr ? "output-available" : "output-error",
          input: tc.input,
          output: tr?.output,
        });
      }
    }

    if (m.content) parts.push({ type: "text" as const, text: m.content });

    return {
      id: m.id,
      role: m.role,
      parts,
      metadata: {
        createdAt: m.createdAt?.toISOString() ?? null,
        platform: m.platform ?? "web",
        taskStatus: meta?.status,
      },
    };
  });

  return Response.json(uiMessages);
}
