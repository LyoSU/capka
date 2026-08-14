import { setEnabled, upsertServer, upsertStdioServer } from "@/lib/mcp/service";
import { ingestSkill } from "@/lib/skills/service";
import type { ReviewObservations } from "./observe";
import type { ResolvedPluginPlan } from "./plan";
import type { InstallManifest } from "./types";

/**
 * The only place a plan becomes rows. Performs no fetch and no probe, so it is safe
 * to call with a transaction open (docs/plugin-install-review-spec.md §7) and can be
 * exercised without a network stub.
 *
 * Every decision here was made by `buildPluginPlan`; this function only carries them
 * out. That is what makes a review meaningful: what applies is what was reviewed.
 */
export async function applyPlanResources(
  plan: ResolvedPluginPlan,
  obs: ReviewObservations,
  tag: string,
  target: { scope: "system" | "user"; userId: string | null; projectId: string | null },
): Promise<InstallManifest> {
  const manifest: InstallManifest = {
    skills: [], connectors: [], ignored: plan.ignored, notes: plan.notes, commit: plan.commit,
    ...(plan.version ? { version: plan.version } : {}),
    ...(plan.displayName ? { displayName: plan.displayName } : {}),
  };

  for (const c of plan.connectors) {
    if (c.kind === "stdio") {
      // Consent gate: EVERY marketplace stdio server runs third-party code in the
      // user's sandbox — bundled plugin code OR a bare `npx`/`uvx`/`pip` command that
      // fetches and executes a remote package. The distinction is irrelevant to the
      // threat, so install ALL of them OFF; an admin reviews and enables from
      // Extensions. (Sandbox isolation is the containment; this is informed consent.)
      const sid = await upsertStdioServer({ ...target, name: c.name, command: c.command!, args: c.args, env: c.env, source: tag });
      await setEnabled(sid, false);
    } else {
      const authKind = obs.detectedAuth[c.name] ?? "token";
      const secrets = c.headers && !c.hasPlaceholder ? { headers: c.headers } : undefined;
      const id = await upsertServer({ ...target, name: c.name, url: c.url!, secrets, authKind, source: tag });
      if (c.hasPlaceholder) await setEnabled(id, false);
    }
    manifest.connectors.push(c.name);
  }

  for (const s of plan.skills) {
    await ingestSkill(s.parsed, s.files, { ...target, source: tag });
    manifest.skills.push(s.name);
  }

  return manifest;
}
