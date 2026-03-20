import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import type { ToolAction } from "@mastra/core/tools";

const connectionString =
  process.env.DATABASE_URL || "postgresql://anticlaw:anticlaw@localhost:5432/anticlaw";

const storage = new PostgresStore({
  id: "anticlaw-memory",
  connectionString,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  tools: Record<string, ToolAction<any, any, any, any, any, any>>,
) {
  return new Agent({
    id: "chat-agent",
    name: "AntiClaw Assistant",
    instructions:
      "You are a helpful personal AI assistant. Be concise and direct. Confirm before executing actions with side effects.",
    model: model as any,
    tools,
    memory: chatAgentMemory,
  });
}
