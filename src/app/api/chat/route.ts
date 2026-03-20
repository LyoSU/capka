import { streamText, convertToModelMessages, type ToolSet } from "ai";
import { eq, asc } from "drizzle-orm";
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

    // Parallel: check chat existence, resolve model, load MCP tools
    const [existingChat, model, { tools, disconnect }] = await Promise.all([
      db.select().from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0]),
      resolveUserModel(userId, requestModel).catch((e: Error) =>
        Promise.reject(Response.json({ error: e.message }, { status: 400 })),
      ),
      loadMCPTools(userId),
    ]);

    if (!existingChat) {
      await db.insert(chats).values({ id: chatId, userId, title: "New Chat", model: requestModel });
    }

    // Save the latest user message
    const lastUserMsg = body.messages?.filter((m: { role: string }) => m.role === "user").pop();
    if (lastUserMsg) {
      const text = lastUserMsg.parts
        ?.filter((p: { type: string }) => p.type === "text")
        .map((p: { text: string }) => p.text)
        .join("") || lastUserMsg.content || "";

      if (text) {
        await db.insert(messages).values({
          id: lastUserMsg.id || nanoid(),
          chatId,
          role: "user",
          content: text,
          platform: "web",
        });

        // Auto-generate title from first message, or just bump updatedAt
        const isNewChat = !existingChat || existingChat.title === "New Chat";
        await db.update(chats).set({
          ...(isNewChat ? { title: text.slice(0, 100) } : {}),
          updatedAt: new Date(),
        }).where(eq(chats.id, chatId));
      }
    }

    const result = streamText({
      model,
      tools: tools as ToolSet,
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(body.messages),
      onError: (error) => console.error("[chat] Stream error:", error),
      async onFinish({ text }) {
        if (text) {
          await db.insert(messages).values({
            id: nanoid(),
            chatId,
            role: "assistant",
            content: text,
            platform: "web",
          });
        }
        await disconnect();
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (e: unknown) {
    // If it's already a Response (from resolveUserModel rejection), return it
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

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt))
    .limit(100);

  const uiMessages = rows.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }],
    metadata: {
      createdAt: m.createdAt?.toISOString() ?? null,
      platform: m.platform ?? "web",
    },
  }));

  return NextResponse.json(uiMessages);
}
