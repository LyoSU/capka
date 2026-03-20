import { Header } from "@/components/layout/header";
import { MessageSquare } from "lucide-react";

export default function ChatPage() {
  return (
    <>
      <Header title="Chat" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <MessageSquare className="h-8 w-8" />
        <p>Start a conversation</p>
      </div>
    </>
  );
}
