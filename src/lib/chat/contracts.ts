import { z } from "zod";

// Inbound POST /api/chat body
export const chatRequestSchema = z.object({
  chatId: z.string().optional(),
  model: z.string().optional(),
  projectId: z.string().optional(),
  userMessage: z.string().default(""),
  attachedFiles: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  messages: z.array(z.any()).optional(),
});

// Stored in messages.metadata.parts — the DB representation
export const storedPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("tool-call"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool-result"), id: z.string(), name: z.string(), output: z.unknown() }),
  z.object({ type: z.literal("tool-error"), id: z.string(), name: z.string(), error: z.string() }),
]);
export type StoredPart = z.infer<typeof storedPartSchema>;

export type MessageMeta = {
  taskId?: string;
  status?: string;
  error?: string;
  parts?: StoredPart[];
  // Legacy format
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolResults?: { id: string; name: string; output: unknown }[];
};
