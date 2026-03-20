import { createUIMessageStreamResponse } from "ai";
import { handleChatStream } from "@mastra/ai-sdk";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs, chats } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";
import { createChatAgent } from "@/lib/agents/chat-agent";
import { mastra } from "@/lib/agents";
import { createMCPClient } from "@/lib/mcp/config";

export async function POST(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
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
    return new Response("No LLM provider configured", { status: 400 });
  }

  // Decrypt API key if present
  let apiKey = config.apiKey;
  if (apiKey) {
    const mk = await getMasterKey();
    apiKey = decrypt(apiKey, mk);
  }

  // Resolve model
  const modelId = requestModel || config.defaultModel || "gpt-4o";
  const model = getModel(config.provider, modelId, {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });

  // Create MCP client for filesystem tools
  const mcpClient = createMCPClient(`./data/storage/${userId}`);
  const tools = await mcpClient.listTools();

  // Register a dynamic agent with the resolved model + tools
  const agent = createChatAgent(model, tools);
  mastra.addAgent(agent);

  // Stream the response
  const stream = await handleChatStream({
    mastra,
    agentId: "chat-agent",
    params: {
      ...body,
      messages: body.messages,
      memory: { thread: chatId, resource: userId },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createUIMessageStreamResponse({ stream: stream as any });
}
