import { resolveUserModel } from "@/lib/providers/resolve";
import { loadMCPTools } from "@/lib/mcp/config";
import { createChatAgent } from "@/lib/agents/chat-agent";

export async function processMessageForTelegram(
  userId: string,
  chatId: string,
  userMessage: string,
): Promise<string> {
  const model = await resolveUserModel(userId);
  const { tools, close } = await loadMCPTools(userId);

  const agent = createChatAgent(model, tools);
  const response = await agent.generate(userMessage, {
    memory: { thread: chatId, resource: userId },
  });

  await close();
  return response.text;
}
