import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { PROVIDER_MODELS } from "@/lib/providers";
import { ChatPanel } from "@/components/chat/chat-panel";

export default async function ChatIdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const { id: chatId } = await params;

  // Load user's active provider config to determine default model
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

  const defaultModel = config
    ? `${config.provider}:${config.defaultModel || PROVIDER_MODELS[config.provider]?.[0] || "gpt-4o"}`
    : "openai:gpt-4o";

  return (
    <ChatPanel
      chatId={chatId}
      providers={PROVIDER_MODELS}
      defaultModel={defaultModel}
    />
  );
}
