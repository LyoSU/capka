import { streamText, convertToModelMessages } from "ai";
import { eq, and, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs, chats, messages } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";

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

    // Ensure or create chat
    const chatId = requestChatId || nanoid();
    if (!requestChatId) {
      await db.insert(chats).values({
        id: chatId,
        userId,
        title: "New Chat",
        model: requestModel,
      });
    }

    // Load active provider config
    const [config] = await db
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
      .limit(1);

    if (!config) {
      return Response.json(
        { error: "No LLM provider configured. Go to Settings → Connections to add one." },
        { status: 400 },
      );
    }

    // Decrypt API key
    let apiKey = config.apiKey;
    if (apiKey) {
      const mk = await getMasterKey();
      apiKey = decrypt(apiKey, mk);
    }

    // Resolve model: client selection > user's DB default > provider's first model
    let provider = config.provider;
    let modelId = config.defaultModel || "";

    if (requestModel && requestModel.includes(":")) {
      const [p, ...rest] = requestModel.split(":");
      provider = p;
      modelId = rest.join(":");
    } else if (requestModel) {
      modelId = requestModel;
    }

    if (!modelId) {
      return Response.json(
        { error: "No default model configured. Go to Settings → Connections to set one." },
        { status: 400 },
      );
    }

    let model;
    try {
      model = getModel(provider, modelId, {
        apiKey: apiKey || undefined,
        baseUrl: config.baseUrl || undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return Response.json(
        { error: `Failed to initialize model "${provider}/${modelId}": ${msg}` },
        { status: 400 },
      );
    }

    // Save the latest user message to DB
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

        // Auto-generate chat title from first message
        const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
        if (chat?.title === "New Chat") {
          await db.update(chats).set({
            title: text.slice(0, 100),
            updatedAt: new Date(),
          }).where(eq(chats.id, chatId));
        } else {
          await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));
        }
      }
    }

    // Stream via AI SDK
    const result = streamText({
      model,
      system:
        "You are a helpful personal AI assistant called AntiClaw. Be concise and direct. Confirm before executing actions with side effects.",
      messages: await convertToModelMessages(body.messages),
      onError: (error) => {
        console.error("[chat] Stream error:", error);
      },
      async onFinish({ text }) {
        // Save assistant response to DB
        if (text) {
          await db.insert(messages).values({
            id: nanoid(),
            chatId,
            role: "assistant",
            content: text,
            platform: "web",
          });
        }
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (e: unknown) {
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

  // Convert to UIMessage format for useChat
  const uiMessages = rows.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }],
    createdAt: m.createdAt,
  }));

  return NextResponse.json(uiMessages);
}
