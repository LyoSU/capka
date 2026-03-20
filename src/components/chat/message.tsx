import { type UIMessage } from "ai";
import { Bot, User, Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, useCallback } from "react";

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  if (!match) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        {children}
      </code>
    );
  }

  return (
    <div className="group relative my-3">
      {language && (
        <div className="flex items-center justify-between rounded-t-md border border-b-0 bg-muted/50 px-3 py-1">
          <span className="text-xs text-muted-foreground">{language}</span>
        </div>
      )}
      <div className="relative">
        <pre className={`overflow-x-auto bg-muted p-3 font-mono text-xs ${language ? "rounded-b-md border border-t-0" : "rounded-md"}`}>
          <code>{code}</code>
        </pre>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

function MessageContent({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_table]:text-xs">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) => (
            <CodeBlock className={className}>{children}</CodeBlock>
          ),
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  return (
    <div className={`flex gap-3 px-4 py-4 ${isUser ? "flex-row-reverse" : ""}`}>
      <MessageAvatar role={message.role} />
      <div
        className={`min-w-0 max-w-[80%] ${
          isUser ? "rounded-md bg-muted px-3 py-2" : ""
        }`}
      >
        {text ? (
          <MessageContent text={text} />
        ) : (
          <span className="text-muted-foreground text-sm animate-pulse">...</span>
        )}
      </div>
    </div>
  );
}
