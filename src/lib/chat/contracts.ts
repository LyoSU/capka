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
  // cacheWrite + reasoning are display-only splits (reasoning is already part of
  // `output`); present only when non-zero. Captured generically from the AI SDK's
  // normalized usage, so they work for every provider, not just OpenRouter.
  usage?: { input: number; output: number; cached: number; cacheWrite?: number; reasoning?: number };
  costUsd?: number;
  // Where `costUsd` came from: "provider" = the gateway's real billed charge
  // (authoritative, may legitimately be 0 for a free/subscription model),
  // "catalog" = our price-book estimate. Lets the UI mark estimates as approximate.
  costSource?: "provider" | "catalog";
  // The real upstream provider that served this turn (OpenRouter routes one model
  // id across many providers). Shown in the (i) popover's route section.
  upstreamProvider?: string;
  // OpenRouter generation id (`gen-…`) + the provider config it ran on. Together
  // they let the (i) popover lazily fetch this turn's latency + provider chain via
  // GET /api/v1/generation, billed to the same key. OpenRouter turns only.
  generationId?: string;
  configId?: string;
  // Effective context window (model window ∩ admin cap) at this turn. With
  // `usage`, lets the UI render a "context full" meter: (input+cached)/this.
  contextWindow?: number;
  // The LAST LLM call's actual prompt size (that step's input+cached), i.e. the
  // real context size at the end of this turn. `usage.input`/`usage.cached` sum
  // across every step of a multi-step tool-calling turn, so they overstate the
  // window fill once the turn made more than one call — this is the number the
  // "context full" meter should divide by contextWindow, not the turn total.
  contextTokens?: number;
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
  // Marks this row as a COMPACTION CHECKPOINT — a summary that stands in for
  // every turn up to `summarizedUpTo` when building context for the model. The
  // full history stays in the DB and in the UI transcript (rendered as a
  // divider); only what we feed the model is collapsed. Written by the runner's
  // async compaction step. `tokensSaved` is best-effort, for the UI/analytics.
  compaction?: { summary: string; summarizedUpTo: string; tokensSaved?: number };
  // Legacy format
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolResults?: { id: string; name: string; output: unknown }[];
};
