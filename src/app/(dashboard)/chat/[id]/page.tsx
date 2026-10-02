import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";

import { getTranslations } from "next-intl/server";

import { currentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, chats, users } from "@/lib/db/schema";
import { resolveInitialModel } from "@/lib/providers/default-model";
import { parseThinkAmount } from "@/lib/models/thinking";
import { projectNotDeleted } from "@/lib/projects/live";
import { isShareImportEnabled } from "@/lib/import/flag";
import { loadTranscript } from "@/lib/chat/transcript";
import { ChatPanel } from "@/components/chat/chat-panel";
import type { TranscriptMessage } from "@/hooks/use-background-chat";
import { ChatTitleSync } from "@/components/chat/chat-title-sync";

// The browser tab carries the conversation's own name, so a window with three
// chats open is readable. Scoped by userId like every other read here — a title
// is user content, and a guessed id must not reveal someone else's. An unsaved
// chat (no row yet) and an untitled one both fall back to the same placeholder
// the sidebar shows, so the tab and the list agree.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return {};

  const { id } = await params;
  const [chat] = await db
    .select({ title: chats.title })
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, session.user.id)))
    .limit(1);

  const t = await getTranslations("chat");
  return { title: chat?.title || t("untitled") };
}

export default async function ChatIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id: chatId } = await params;
  const { projectId: qsProjectId } = await searchParams;

  // Load existing chat to check for projectId. activeLeafId tells us, on the
  // server, whether this chat already has messages (null = empty) — the client
  // uses it to render the right shell on first paint instead of flashing the
  // new-chat greeting while history is still being fetched.
  const [existingChat] = await db
    .select({ title: chats.title, projectId: chats.projectId, model: chats.model, thinkAmount: chats.thinkAmount, source: chats.source, activeLeafId: chats.activeLeafId })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
    .limit(1);

  const projectId = existingChat?.projectId ?? qsProjectId ?? null;

  // The transcript rides along with the page, so opening a chat is one round trip
  // instead of the page and then the client's own GET /api/chat queued behind the
  // panel's other boot requests. Same loader as that route, so the same answer;
  // the row above is already scoped to this user, which is the route's ownership
  // check. Started now, awaited last: it needs only the chat row. A chat with no
  // row (a fresh /chat/<id>), or no messages, has nothing to load; a failed read
  // leaves the panel to fetch it as it always did, rather than failing the page.
  const transcript = existingChat?.activeLeafId
    ? loadTranscript(chatId, session.user.id, existingChat.activeLeafId).catch(() => undefined)
    : undefined;

  const project = projectId
    ? await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id), projectNotDeleted))
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
  const initialMessages = await transcript;

  return (
    <>
      {/* The title above is a first-paint snapshot; this keeps it live once the
          generated name (or a rename) arrives. */}
      <ChatTitleSync chatId={chatId} />
      <ChatPanel
        key={chatId}
        chatId={chatId}
        defaultModel={defaultModel}
        initialThinkAmount={parseThinkAmount(existingChat?.thinkAmount)}
        projectId={projectId ?? undefined}
        isAdmin={userRow?.role === "admin"}
        projectName={project?.name}
        readOnly={existingChat?.source === "telegram"}
        initialHasHistory={!!existingChat?.activeLeafId}
        initialMessages={initialMessages as TranscriptMessage[] | undefined}
        userName={session.user.name}
        shareImportEnabled={isShareImportEnabled()}
        title={existingChat?.title}
      />
    </>
  );
}
