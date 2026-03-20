import { redirect } from "next/navigation";
import { nanoid } from "nanoid";

// Always create a new chat — sidebar handles navigation to existing chats
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { projectId } = await searchParams;
  const chatId = nanoid();
  const url = projectId ? `/chat/${chatId}?projectId=${projectId}` : `/chat/${chatId}`;
  redirect(url);
}
