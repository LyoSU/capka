import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs, projects, chats } from "@/lib/db/schema";
import { ChatPanel } from "@/components/chat/chat-panel";

export default async function ChatIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { id: chatId } = await params;
  const { projectId: qsProjectId } = await searchParams;

  // Load existing chat to check for projectId
  const [existingChat] = await db
    .select({ projectId: chats.projectId })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
    .limit(1);

  const projectId = existingChat?.projectId ?? qsProjectId ?? null;

  const [config, project] = await Promise.all([
    db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.userId, session.user.id),
          eq(providerConfigs.isActive, true),
        ),
      )
      .limit(1)
      .then((r) => r[0]),
    projectId
      ? db
          .select()
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id)))
          .limit(1)
          .then((r) => r[0])
      : Promise.resolve(undefined),
  ]);

  // Project's defaultModel overrides provider default
  const defaultModel = project?.defaultModel
    ? project.defaultModel
    : config?.defaultModel
      ? `${config.provider}:${config.defaultModel}`
      : "";

  return (
    <ChatPanel
      chatId={chatId}
      defaultModel={defaultModel}
      projectId={projectId ?? undefined}
    />
  );
}
