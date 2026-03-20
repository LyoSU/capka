import { streamText, convertToModelMessages } from "ai";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs, chats } from "@/lib/db/schema";
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

    // Parse "provider:modelId" from client, or use DB defaults
    let provider = config.provider;
    let modelId = config.defaultModel || "gpt-4.1";

    if (requestModel && requestModel.includes(":")) {
      const [p, ...rest] = requestModel.split(":");
      provider = p;
      modelId = rest.join(":");
    } else if (requestModel) {
      modelId = requestModel;
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

    // Stream via AI SDK
    const result = streamText({
      model,
      system:
        "You are a helpful personal AI assistant called AntiClaw. Be concise and direct. Confirm before executing actions with side effects.",
      messages: convertToModelMessages(body.messages),
      onError: (error) => {
        console.error("[chat] Stream error:", error);
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (e: unknown) {
    console.error("[chat] Unexpected error:", e);
    const msg = e instanceof Error ? e.message : "An unexpected error occurred";
    return Response.json({ error: msg }, { status: 500 });
  }
}
