import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, users } from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import { ProjectHub } from "@/components/projects/project-hub";

export default async function ProjectHubPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { id } = await params;
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id), projectNotDeleted))
    .limit(1);
  if (!project) notFound();

  const [userRow] = await db.select({ role: users.role }).from(users).where(eq(users.id, session.user.id)).limit(1);

  return (
    <ProjectHub
      isAdmin={userRow?.role === "admin"}
      project={{
        id: project.id,
        name: project.name,
        description: project.description,
        systemPrompt: project.systemPrompt,
        defaultModel: project.defaultModel,
        sandboxNetwork: project.sandboxNetwork,
        createdAt: project.createdAt ? project.createdAt.toISOString() : null,
        updatedAt: project.updatedAt ? project.updatedAt.toISOString() : null,
      }}
    />
  );
}
