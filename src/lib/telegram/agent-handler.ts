import { generateText, stepCountIs } from "ai";
import { resolveUserModel } from "@/lib/providers/resolve";
import { loadMCPTools } from "@/lib/mcp/config";
import { SYSTEM_PROMPT } from "@/lib/agents/chat-agent";

export async function processMessageForTelegram(
  userId: string,
  chatId: string,
  userMessage: string,
): Promise<string> {
  const model = await resolveUserModel(userId);
  const { tools, close } = await loadMCPTools(userId);

  try {
    const hasTools = Object.keys(tools).length > 0;
    const { text } = await generateText({
      model,
      system: SYSTEM_PROMPT,
      ...(hasTools ? { tools, stopWhen: stepCountIs(25) } : {}),
      messages: [{ role: "user", content: userMessage }],
    });
    return text;
  } finally {
    await close();
  }
}
