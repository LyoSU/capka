import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";
import { createChatAgent } from "@/lib/agents/chat-agent";
import { createMCPClient } from "@/lib/mcp/config";

export async function processMessageForTelegram(
  userId: string,
  chatId: string,
  userMessage: string,
): Promise<string> {
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) throw new Error("No LLM provider configured. Set one up in Settings.");

  if (!config.defaultModel) {
    throw new Error("No default model set. Configure one in Settings → Connections.");
  }

  let apiKey = config.apiKey;
  if (apiKey) {
    const mk = await getMasterKey();
    apiKey = decrypt(apiKey, mk);
  }

  const model = getModel(config.provider, config.defaultModel, {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });

  const mcpClient = createMCPClient(`./data/storage/${userId}`);
  let tools;
  try {
    tools = await mcpClient.listTools();
  } catch {
    tools = {}; // MCP may not be available — proceed without tools
  }

  const agent = createChatAgent(model, tools);

  const response = await agent.generate(userMessage, {
    memory: { thread: chatId, resource: userId },
  });

  try { await mcpClient.disconnect(); } catch { /* ignore */ }
  return response.text;
}
