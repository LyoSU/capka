import { apiHandler, requireSession, requireActive } from "@/lib/auth";
import { ingestSkillZip, MAX_SKILL_ZIP_BYTES, SkillZipError } from "@/lib/skills/ingest-zip";
import { deleteSkill, getSkillMeta, listManagedSkills, setSkillEnabled } from "@/lib/skills/service";
import { setMuted } from "@/lib/muted-resources";
import { SkillParseError } from "@/lib/skills/types";

export const GET = apiHandler(async () => {
  const { userId, role } = await requireSession();
  const list = await listManagedSkills(userId, role === "admin");

  // Plugin-installed skills (source = catalog:*) are managed as a unit on the
  // Extensions tab; the Library shows only hand-added skills so nothing appears twice.
  return Response.json({
    skills: list
      .filter((s) => !s.source.startsWith("catalog:"))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        scope: s.scope,
        enabled: s.enabled,
        mine: s.mine,
      })),
  });
});

/** Upload a personal (user-scope) skill .zip. */
export const POST = apiHandler(async (req: Request) => {
  // requireActive: a not-yet-approved account must not ingest third-party code.
  const { userId } = await requireActive();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file" }, { status: 400 });
  if (file.size > MAX_SKILL_ZIP_BYTES) return Response.json({ error: "Zip too large" }, { status: 413 });

  try {
    const res = await ingestSkillZip(Buffer.from(await file.arrayBuffer()), {
      scope: "user",
      userId,
      projectId: null,
      source: "manual",
    });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof SkillParseError || e instanceof SkillZipError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
});

/**
 * Toggle a skill for the caller. Own (user-scope) skill → flips its global flag.
 * Shared (system/project) skill → records the caller's personal mute, leaving
 * it on for everyone else (admins manage the global flag via /api/admin/skills).
 */
export const PATCH = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // Only let the caller toggle a skill they can actually see/use. An unknown id
  // and a shared skill the caller has no access to return the SAME not-found, so
  // this can't be used to enumerate skill ids by probing.
  const skill = (await listManagedSkills(userId, role === "admin")).find((s) => s.id === id);
  if (!skill) return Response.json({ error: "Not found" }, { status: 404 });

  if (skill.mine) {
    await setSkillEnabled(id, enabled);
  } else {
    // Shared skill: mute/unmute for this user only (enabled=false → muted).
    await setMuted(userId, "skill", id, !enabled);
  }
  return Response.json({ ok: true });
});

/** Delete one of the caller's own personal skills. */
export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const skill = await getSkillMeta(id);
  if (!skill || skill.scope !== "user" || skill.userId !== userId) {
    return Response.json({ error: "Not found or not yours" }, { status: 404 });
  }
  await deleteSkill(id);
  return Response.json({ ok: true });
});
