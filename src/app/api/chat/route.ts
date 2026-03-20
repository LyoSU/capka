import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { eq, and, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages } from "@/lib/db/schema";
import { resolveUserModel } from "@/lib/providers/resolve";
import { loadMCPTools } from "@/lib/mcp/config";
import { SYSTEM_PROMPT } from "@/lib/agents/chat-agent";

export async function POST(req: Request) {
  let mcpClose: (() => Promise<void>) | undefined;

  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return Response.json({ error: "Not authenticated. Please sign in." }, { status: 401 });
    }

    const userId = session.user.id;
    const body = await req.json();
    const { chatId: requestChatId, model: requestModel } = body;
    const chatId = requestChatId || nanoid();

    // Parallel: check chat ownership, resolve model, load MCP tools
    const [existingChat, model, mcp] = await Promise.all([
      db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).limit(1).then((r) => r[0]),
      resolveUserModel(userId, requestModel),
      loadMCPTools(userId),
    ]);
    mcpClose = mcp.close;
    const { tools } = mcp;

    // If chatId was provided but doesn't belong to this user, reject
    if (requestChatId && !existingChat) {
      await mcpClose();
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }

    if (!existingChat) {
      await db.insert(chats).values({ id: chatId, userId, title: "New Chat", model: requestModel });
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

    const hasTools = Object.keys(tools).length > 0;
    const result = streamText({
      model,
      ...(hasTools ? { tools, stopWhen: stepCountIs(25) } : {}),
      system: SYSTEM_PROMPT,
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
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  // Verify chat belongs to user
  const [chat] = await db.select({ id: chats.id }).from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
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
