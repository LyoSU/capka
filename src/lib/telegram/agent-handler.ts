import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";
import { createChatAgent } from "@/lib/agents/chat-agent";
import { mastra } from "@/lib/agents";
import { createMCPClient } from "@/lib/mcp/config";

export async function processMessageForTelegram(
  userId: string,
  chatId: string,
  userMessage: string,
): Promise<string> {
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(
      and(
        eq(providerConfigs.userId, userId),
        eq(providerConfigs.isActive, true),
      ),
    )
    .limit(1);
  if (!config) throw new Error("No LLM provider configured");

  let apiKey = config.apiKey;
  if (apiKey) {
    const mk = await getMasterKey();
    apiKey = decrypt(apiKey, mk);
  }

  const model = getModel(config.provider, config.defaultModel || "gpt-4o", {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });

  const mcpClient = createMCPClient(`./data/storage/${userId}`);
  const tools = await mcpClient.listTools();

  const agent = createChatAgent(model, tools);
  mastra.addAgent(agent);

  const response = await agent.generate(userMessage, {
    memory: { thread: chatId, resource: userId },
  });

  await mcpClient.disconnect();
  return response.text;
}
