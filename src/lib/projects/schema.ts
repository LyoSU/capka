import { z } from "zod";

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
});

export const projectUpdateSchema = projectCreateSchema.partial();

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
