import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import { chatAgentMemory } from "./chat-agent";

const connectionString =
  process.env.DATABASE_URL || "postgresql://anticlaw:anticlaw@localhost:5432/anticlaw";

export const mastra = new Mastra({
  storage: new PostgresStore({ id: "anticlaw-store", connectionString }),
  memory: { "chat-agent": chatAgentMemory },
});
