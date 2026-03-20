import { type UIMessage } from "ai";
import { Bot, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function MessageAvatar({ role }: { role: string }) {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
      {role === "assistant" ? (
        <Bot className="h-4 w-4" />
      ) : (
        <User className="h-4 w-4" />
      )}
    </div>
  );
}

function MessageContent({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  if (!text) return null;

  return (
    <div className={`flex gap-3 px-4 py-4 ${isUser ? "flex-row-reverse" : ""}`}>
      <MessageAvatar role={message.role} />
      <div
        className={`min-w-0 max-w-[80%] ${
          isUser ? "rounded-md bg-muted px-3 py-2" : ""
        }`}
      >
        <MessageContent text={text} />
      </div>
    </div>
  );
}
