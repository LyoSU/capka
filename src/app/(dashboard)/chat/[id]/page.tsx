import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { ChatPanel } from "@/components/chat/chat-panel";

export default async function ChatIdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { id: chatId } = await params;

  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(
      and(
        eq(providerConfigs.userId, session.user.id),
        eq(providerConfigs.isActive, true),
      ),
    )
    .limit(1);

  const defaultModel = config?.defaultModel
    ? `${config.provider}:${config.defaultModel}`
    : "";

  return (
    <ChatPanel
      chatId={chatId}
      defaultModel={defaultModel}
    />
  );
}
