import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { models, projects, users } from "@/lib/db/schema";
import { splitModelRef } from "@/lib/providers/registry";
import { idMatch } from "@/lib/models/catalog";
import { projectNotDeleted } from "@/lib/projects/live";
import { parseAgentProfile } from "@/lib/agents/profile";
import { getOrgAgentProfile } from "@/lib/settings";
import { ProjectHub, type HubTab } from "@/components/projects/project-hub";

export default async function ProjectHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { id } = await params;
  const { tab } = await searchParams;
  const initialTab: HubTab | undefined =
    tab === "files" || tab === "chats" || tab === "settings" ? tab : undefined;
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id), projectNotDeleted))
    .limit(1);
  if (!project) notFound();

  // The readable name of the project's default model, read from the synced
  // catalog rather than guessed from its id. `defaultModel` is stored as a
  // config-scoped ref, and the catalog keys on the canonical `vendor/model` id —
  // hence matching the bare id both ways, since a ref may or may not carry the
  // vendor prefix. A custom model nobody's catalog knows about simply has no row,
  // and the hub falls back to showing the id as typed.
  const bareModelId = project.defaultModel ? splitModelRef(project.defaultModel).modelId : null;
  const [userRow, orgCeiling, modelRow] = await Promise.all([
    db.select({ role: users.role }).from(users).where(eq(users.id, session.user.id)).limit(1).then((r) => r[0]),
    getOrgAgentProfile(),
    bareModelId
      ? db
          .select({ displayName: models.displayName, group: models.group })
          .from(models)
          .where(idMatch(bareModelId))
          .limit(1)
          .then((r) => r[0])
      : undefined,
  ]);

  // Drop the "Vendor:" the catalog bakes into display names, the same way the
  // model picker's own trigger does — otherwise the identical model reads as
  // "Anthropic: Claude …" in the header and "Claude …" in the field below it.
  const defaultModelName = modelRow?.displayName
    ? modelRow.group && modelRow.displayName.toLowerCase().startsWith(`${modelRow.group.toLowerCase()}:`)
      ? modelRow.displayName.slice(modelRow.group.length + 1).trim()
      : modelRow.displayName
    : null;

  return (
    <ProjectHub
      isAdmin={userRow?.role === "admin"}
      initialTab={initialTab}
      orgCeiling={orgCeiling}
      defaultModelName={defaultModelName}
      project={{
        id: project.id,
        name: project.name,
        description: project.description,
        systemPrompt: project.systemPrompt,
        defaultModel: project.defaultModel,
        sandboxNetwork: project.sandboxNetwork,
        // Normalized here, not in the component: the client then always holds a
        // COMPLETE profile (null and partial rows resolve to defaults server-side),
        // so the settings form has no shape to guess at.
        agentProfile: parseAgentProfile(project.agentProfile),
        createdAt: project.createdAt ? project.createdAt.toISOString() : null,
        updatedAt: project.updatedAt ? project.updatedAt.toISOString() : null,
      }}
    />
  );
}
