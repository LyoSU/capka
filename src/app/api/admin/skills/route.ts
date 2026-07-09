import { requireAdmin, apiHandler } from "@/lib/auth";
import { ingestSkillZip, MAX_SKILL_ZIP_BYTES, SkillZipError } from "@/lib/skills/ingest-zip";
import { deleteSkill, getSkillMeta, setSkillEnabled } from "@/lib/skills/service";
import { SkillParseError, type SkillScope } from "@/lib/skills/types";
import { audit } from "@/lib/governance/audit";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const rl = take(`admin-skills:${userId}`);
  if (!rl.ok) return Response.json({ error: "Too many requests — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  const form = await req.formData();
  const file = form.get("file");
  const scope = (form.get("scope") as string) || "system";
  if (!(file instanceof File)) return Response.json({ error: "Missing file" }, { status: 400 });
  if (file.size > MAX_SKILL_ZIP_BYTES) return Response.json({ error: "Zip too large" }, { status: 413 });
  if (!["system", "project"].includes(scope)) {
    return Response.json({ error: "Bad scope" }, { status: 400 });
  }

  try {
    const res = await ingestSkillZip(Buffer.from(await file.arrayBuffer()), {
      scope: scope as SkillScope,
      userId: null,
      projectId: null,
      source: "manual",
    });
    // A shared skill can carry executable content — record who added what.
    await audit({ actorId: userId, action: "skill.add", targetType: "skill", targetKey: res.name, detail: { scope } });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof SkillParseError || e instanceof SkillZipError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
});

/** Admin toggles a shared (system/project) skill. User-scope skills are owner-managed via /api/skills. */
export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const skill = await getSkillMeta(id);
  if (!skill || skill.scope === "user") return Response.json({ error: "Not found" }, { status: 404 });
  await setSkillEnabled(id, enabled);
  await audit({ actorId: userId, action: enabled ? "skill.enable" : "skill.disable", targetType: "skill", targetKey: id, detail: { name: skill.name } });
  return Response.json({ ok: true });
});

/** Admin deletes a shared (system/project) skill. If it came from a plugin it may
 *  reappear on the next install/update — uninstall the plugin to remove it for good. */
export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const skill = await getSkillMeta(id);
  if (!skill || skill.scope === "user") return Response.json({ error: "Not found" }, { status: 404 });
  await deleteSkill(id);
  await audit({ actorId: userId, action: "skill.remove", targetType: "skill", targetKey: id, detail: { name: skill.name } });
  return Response.json({ ok: true });
});
