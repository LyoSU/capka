import { redirect } from "next/navigation";
import { nanoid } from "nanoid";

export default function ChatPage() {
  redirect(`/chat/${nanoid()}`);
}
