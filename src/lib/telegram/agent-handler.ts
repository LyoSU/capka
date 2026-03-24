import { generateText, stepCountIs } from "ai";
import { resolveUserModel } from "@/lib/providers/resolve";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { SYSTEM_PROMPT, SANDBOX_PROMPT } from "@/lib/agents/chat-agent";

export async function processMessageForTelegram(
  userId: string,
  chatId: string,
  userMessage: string,
): Promise<string> {
  const model = await resolveUserModel(userId);
  const { tools, close } = await loadSandboxTools(userId, chatId);

  try {
    const { text } = await generateText({
      model,
      system: `${SYSTEM_PROMPT}\n\n${SANDBOX_PROMPT}`,
      tools,
      stopWhen: stepCountIs(25),
      messages: [{ role: "user", content: userMessage }],
    });
    return text;
  } finally {
    await close();
  }
}
