import { redirect } from "next/navigation";
import { nanoid } from "nanoid";

// Always create a new chat — sidebar handles navigation to existing chats
export default function ChatPage() {
  redirect(`/chat/${nanoid()}`);
}
