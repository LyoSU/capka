import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { eq, and, asc, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, projects, memories } from "@/lib/db/schema";
import { resolveUserModel } from "@/lib/providers/resolve";
import { loadMCPTools } from "@/lib/mcp/config";
import { SYSTEM_PROMPT } from "@/lib/agents/chat-agent";
import { extractMemories } from "@/lib/memory/extract";

export async function POST(req: Request) {
  let mcpClose: (() => Promise<void>) | undefined;

  try {
    const { userId } = await requireSession();
    const body = await req.json();
    const { chatId: requestChatId, model: requestModel, projectId } = body;
    const chatId = requestChatId || nanoid();

    // Parallel: check chat existence, resolve model, load MCP tools, load project, load memories
    const [chatRow, model, mcp, project, userMemories] = await Promise.all([
      requestChatId
        ? db.select({ id: chats.id, userId: chats.userId, title: chats.title }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0])
        : undefined,
      resolveUserModel(userId, requestModel),
      loadMCPTools(userId),
      projectId
        ? db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1).then((r) => r[0])
        : Promise.resolve(undefined),
      db.select().from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.createdAt)).limit(50),
    ]);
    mcpClose = mcp.close;
    const { tools } = mcp;

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
    const lastUserMsg = body.messages?.filter((m: { role: string }) => m.role === "user").pop();
    if (lastUserMsg) {
      const text = lastUserMsg.parts
        ?.filter((p: { type: string }) => p.type === "text")
        .map((p: { text: string }) => p.text)
        .join("") || lastUserMsg.content || "";

      if (text) {
        const isNewChat = !existingChat || existingChat.title === "New Chat";
        await Promise.all([
          db.insert(messages).values({
            id: lastUserMsg.id || nanoid(),
            chatId,
            role: "user",
            content: text,
            platform: "web",
          }),
          db.update(chats).set({
            ...(isNewChat ? { title: text.slice(0, 100) } : {}),
            updatedAt: new Date(),
          }).where(eq(chats.id, chatId)),
        ]);
      }
    }

    // Build system prompt: base + project instructions + user memories
    let systemPrompt = SYSTEM_PROMPT;
    if (project?.systemPrompt) {
      systemPrompt += `\n\n--- Project Instructions ---\n${project.systemPrompt}`;
    }
    if (userMemories.length > 0) {
      const memoryLines = userMemories.map((m) => `- ${m.content}`).join("\n");
      systemPrompt += `\n\n## Things you know about the user:\n${memoryLines}`;
    }

    const hasTools = Object.keys(tools).length > 0;
    const result = streamText({
      model,
      ...(hasTools ? { tools, stopWhen: stepCountIs(25) } : {}),
      system: systemPrompt,
      messages: await convertToModelMessages(body.messages),
      onError: async () => { await mcpClose?.(); },
      async onFinish({ text, steps }) {
        const toolCalls = steps.flatMap((step) =>
          (step.toolCalls ?? []).map((tc) => ({
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.input,
          })),
        );
        const toolResults = steps.flatMap((step) =>
          (step.toolResults ?? []).map((tr) => ({
            id: tr.toolCallId,
            name: tr.toolName,
            output: tr.output,
          })),
        );

        if (text || toolCalls.length > 0) {
          await db.insert(messages).values({
            id: nanoid(),
            chatId,
            role: "assistant",
            content: text || "",
            platform: "web",
            metadata: toolCalls.length > 0 ? { toolCalls, toolResults } : undefined,
          });
        }

        // Extract and save new memories (fire-and-forget)
        if (text) {
          extractMemories(model, text, userMemories.map((m) => m.content))
            .then(async (newFacts) => {
              if (newFacts.length > 0) {
                await db.insert(memories).values(
                  newFacts.map((content) => ({
                    id: nanoid(),
                    userId,
                    content,
                    type: "fact",
                  })),
                );
              }
            })
            .catch((e) => console.error("[memory] save failed:", e));
        }

        await mcpClose?.();
      },
    });

    return result.toUIMessageStreamResponse();
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

  type ToolMeta = { toolCalls?: { id: string; name: string; input: unknown }[]; toolResults?: { id: string; name: string; output: unknown }[] };

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
      },
    };
  });

  return NextResponse.json(uiMessages);
}
