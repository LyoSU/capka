import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import type { ToolAction } from "@mastra/core/tools";
import { DATABASE_URL } from "@/lib/db";

const storage = new PostgresStore({
  id: "anticlaw-store",
  connectionString: DATABASE_URL,
});

export const chatAgentMemory = new Memory({
  storage,
  options: {
    lastMessages: 40,
    workingMemory: {
      enabled: true,
      template: "# User Context\n- Name:\n- Preferences:\n- Key facts:",
    },
  },
});

export function createChatAgent(
  model: Parameters<typeof Agent>[0]["model"],
  tools: Record<string, ToolAction<any, any, any, any, any, any>>,
) {
  return new Agent({
    id: "chat-agent",
    name: "AntiClaw Assistant",
    instructions:
      "You are a helpful personal AI assistant. Be concise and direct. Confirm before executing actions with side effects.",
    model,
    tools,
    memory: chatAgentMemory,
  });
}
