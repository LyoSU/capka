import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, chats, users } from "@/lib/db/schema";
import { resolveInitialModel } from "@/lib/providers/default-model";
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

  // Load existing chat to check for projectId. activeLeafId tells us, on the
  // server, whether this chat already has messages (null = empty) — the client
  // uses it to render the right shell on first paint instead of flashing the
  // new-chat greeting while history is still being fetched.
  const [existingChat] = await db
    .select({ projectId: chats.projectId, model: chats.model, source: chats.source, activeLeafId: chats.activeLeafId })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
    .limit(1);

  const projectId = existingChat?.projectId ?? qsProjectId ?? null;

  const project = projectId
    ? await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id)))
        .limit(1)
        .then((r) => r[0])
    : undefined;

  const [defaultModel, userRow] = await Promise.all([
    resolveInitialModel(session.user.id, {
      chatModel: existingChat?.model,
      projectDefaultModel: project?.defaultModel,
    }),
    db.select({ role: users.role }).from(users).where(eq(users.id, session.user.id)).limit(1).then((r) => r[0]),
  ]);

  return (
    <ChatPanel
      key={chatId}
      chatId={chatId}
      defaultModel={defaultModel}
      projectId={projectId ?? undefined}
      isAdmin={userRow?.role === "admin"}
      readOnly={existingChat?.source === "telegram"}
      initialHasHistory={!!existingChat?.activeLeafId}
    />
  );
}
