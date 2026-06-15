import AdmZip from "adm-zip";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { sanitizeBundlePath } from "@/lib/skills/paths";
import { ingestSkill } from "@/lib/skills/service";
import { SkillParseError, type SkillScope } from "@/lib/skills/types";

const MAX_ZIP_BYTES = 5 * 1024 * 1024;

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const form = await req.formData();
  const file = form.get("file");
  const scope = (form.get("scope") as string) || "system";
  if (!(file instanceof File)) return Response.json({ error: "Missing file" }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES) return Response.json({ error: "Zip too large" }, { status: 413 });
  if (!["system", "user", "project"].includes(scope)) {
    return Response.json({ error: "Bad scope" }, { status: 400 });
  }

  const zip = new AdmZip(Buffer.from(await file.arrayBuffer()));
  const entries = zip.getEntries();

  // Find SKILL.md (allow it nested one level: <skill>/SKILL.md).
  const skillEntry = entries.find((e) => !e.isDirectory && /(^|\/)SKILL\.md$/.test(e.entryName));
  if (!skillEntry) return Response.json({ error: "No SKILL.md in zip" }, { status: 400 });
  const basePrefix = skillEntry.entryName.replace(/SKILL\.md$/, "");

  let parsed;
  try {
    parsed = parseSkillMarkdown(skillEntry.getData().toString("utf8"));
  } catch (e) {
    if (e instanceof SkillParseError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }

  const files: { path: string; content: string }[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!e.entryName.startsWith(basePrefix)) continue;
    const rel = e.entryName.slice(basePrefix.length);
    const safe = sanitizeBundlePath(rel);
    if (!safe || safe === "SKILL.md") continue;
    files.push({ path: safe, content: e.getData().toString("base64") });
  }

  const id = await ingestSkill(parsed, files, {
    scope: scope as SkillScope,
    userId: null,
    projectId: null,
    source: "manual",
  });
  return Response.json({ ok: true, id, name: parsed.name, files: files.length });
});
