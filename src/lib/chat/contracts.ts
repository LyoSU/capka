import { z } from "zod";
import type { Modality } from "@/lib/providers/registry";

// Inbound POST /api/chat body
export const chatRequestSchema = z.object({
  chatId: z.string().optional(),
  model: z.string().optional(),
  projectId: z.string().optional(),
  userMessage: z.string().default(""),
  // The client's optimistic user-message id. Persisting the row under this id
  // keeps the React key stable across the optimistic → loaded transition, so the
  // bubble doesn't remount (and visibly flash) when history reloads.
  userMessageId: z.string().optional(),
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
  // Failure shape (role-aware): `error` is the friendly user-facing message,
  // `errorDetail` the raw text admins can expand, `errorCategory` the LLM error
  // class used to pick a localized message. Written by the runner on a failed
  // turn; the presenter forwards all three so the message's ErrorNotice survives
  // a reload with the real error, not a generic placeholder.
  error?: string;
  errorDetail?: string;
  errorCategory?: string;
  parts?: StoredPart[];
  // Highest realtime `seq` reflected in `parts` at the moment this snapshot was
  // persisted. A client that (re)mounts mid-stream seeds its applied-seq from
  // this so resumed deltas reconcile against the snapshot (covered/next/gap)
  // instead of appending onto a stale prefix. Only meaningful while streaming
  // (status:"running"); irrelevant once the turn is finalized.
  streamSeq?: number;
  // Tech details for the (i) popover, captured at finalize (completed turns only).
  // Denormalized copies of the usage table + elapsed time so the UI needs no JOIN
  // and the numbers survive a page reload.
  durationMs?: number;
  // Reasoning/tool phase only (start → first answer token), so the "reasoned
  // for …" label reflects thinking time rather than the whole turn.
  reasoningMs?: number;
  model?: string;
  usage?: { input: number; output: number; cached: number };
  costUsd?: number;
  // Files the user attached to THIS message — reference metadata only (name +
  // type, no bytes). Same shape as FileRef / chatRequestSchema.attachedFiles.
  // Lets the chat history show what was attached; the bytes live in the sandbox
  // workspace and are fetched lazily by the client (never re-sent to the model).
  attachedFiles?: { name: string; type: string }[];
  // A non-fatal heads-up surfaced on the turn. `blind-modalities` means the
  // resolved model couldn't natively take one of the attached media types (e.g.
  // an audio note on a text-only model), so it answered without seeing/hearing
  // it — the UI nudges the user to switch to a capable model.
  notice?: { kind: "blind-modalities"; modalities: Modality[] };
  // Legacy format
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolResults?: { id: string; name: string; output: unknown }[];
};
