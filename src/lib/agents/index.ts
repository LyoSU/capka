import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import { DATABASE_URL } from "@/lib/db";
import { chatAgentMemory } from "./chat-agent";

// Single PostgresStore instance shared across Mastra
const storage = new PostgresStore({ id: "anticlaw-store", connectionString: DATABASE_URL });

export const mastra = new Mastra({
  storage,
  memory: { "chat-agent": chatAgentMemory },
});
