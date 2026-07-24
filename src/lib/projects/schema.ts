import { z } from "zod";
import { agentProfileSchema } from "@/lib/agents/profile";

/** The single create/update contract for projects, shared by POST and PUT so the
 *  API validation can't drift below the UI's. Trims the name (a whitespace-only
 *  name is rejected, not stored as an empty project) and bounds every free-text
 *  field. PUT validates with `.partial()`. Off-catalog `defaultModel` ids (stealth
 *  models) are a supported picker feature — deliberately not validated here. */
export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().max(2000).optional(),
  systemPrompt: z.string().max(20000).optional(),
  defaultModel: z.string().optional(),
  sandboxNetwork: z.enum(["none", "bridge"]).default("none"),
  // Validated (not stored as raw client JSON) so the jsonb column can only ever
  // hold a shape `parseAgentProfile` recognizes. Every field is defaulted, so a
  // partial object from the UI normalizes to a complete profile on the way in.
  agentProfile: agentProfileSchema.optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial();

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
