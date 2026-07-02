import { z } from "zod";

/** A single form field. `ask` emits 1..N; MCP elicitation maps its flat JSON
 *  schema onto these. number/boolean exist mainly for MCP parity. */
export const askFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "choice", "number", "boolean"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  multi: z.boolean().optional(),
  optional: z.boolean().optional(),
});
export type AskField = z.infer<typeof askFieldSchema>;

/** A small form the agent (or an MCP server) asks the user to fill. */
export const askFormSchema = z.object({
  title: z.string().optional(),
  fields: z.array(askFieldSchema).min(1).max(10),
});
export type AskForm = z.infer<typeof askFormSchema>;

/** The user's reply, written back as the tool-result / elicitation response. */
export const askAnswerSchema = z.object({
  action: z.enum(["submit", "skip"]),
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;
