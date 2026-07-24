import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, users } from "@/lib/db/schema";
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

  const [userRow, orgCeiling] = await Promise.all([
    db.select({ role: users.role }).from(users).where(eq(users.id, session.user.id)).limit(1).then((r) => r[0]),
    getOrgAgentProfile(),
  ]);

  return (
    <ProjectHub
      isAdmin={userRow?.role === "admin"}
      initialTab={initialTab}
      orgCeiling={orgCeiling}
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
