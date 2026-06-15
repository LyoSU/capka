import { tool } from "ai";
import { z } from "zod";
import { getSkillForRun, listAvailableSkills } from "./service";
import { materializeSkill } from "./materialize";

export interface SkillToolCtx {
  userId: string;
  sessionKey: string;
  projectId: string | null;
}

/**
 * Phase-2 progressive disclosure: loads a skill's full body on demand,
 * materializing its bundle into the sandbox first. Mirrors OpenCode's
 * `skill({name})` tool — returns body + base dir + file manifest.
 *
 * The tool DEFINITION is constant across runs (cache-stable): the set of
 * available skills lives in the system prompt text, not here.
 */
export function makeSkillTool(ctx: SkillToolCtx) {
  return tool({
    description:
      "Load the full instructions for one of the Available Skills listed in the system prompt. " +
      "Call this when a skill's description matches the user's request, then follow its instructions. " +
      "Its bundled files (scripts, references) become available in the sandbox under the returned base directory.",
    inputSchema: z.object({
      name: z.string().describe("The exact skill name from the Available Skills list"),
    }),
    execute: async ({ name }) => {
      const loaded = await getSkillForRun(ctx.userId, ctx.projectId, name);
      if (!loaded) {
        const available = (await listAvailableSkills(ctx.userId, ctx.projectId)).map((s) => s.name);
        return { error: `Skill "${name}" not found. Available skills: ${available.join(", ") || "none"}` };
      }

      const { info, files } = loaded;
      let baseDir = `/skills/${info.name}`;
      let fileList: string[] = [];
      try {
        const mat = await materializeSkill(ctx.sessionKey, info.name, info.body, files);
        baseDir = mat.baseDir;
        fileList = mat.files;
      } catch (e) {
        // Body is still useful even if file materialization failed.
        console.warn(`[skills] materialize failed for ${info.name}:`, e);
      }

      return {
        content: [
          `<skill_content name="${info.name}">`,
          info.body.trim(),
          "",
          `Base directory for this skill: ${baseDir}`,
          "Relative paths in this skill (e.g. scripts/) are relative to this base directory.",
          fileList.length
            ? `<skill_files>\n${fileList.map((f) => `- ${baseDir}/${f}`).join("\n")}\n</skill_files>`
            : "",
          `</skill_content>`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  });
}
