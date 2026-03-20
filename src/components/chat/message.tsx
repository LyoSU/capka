import { type UIMessage } from "ai";
import {
  Copy, Check, Send,
  Wrench, ChevronRight, Loader2, X, CheckCircle2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, useCallback } from "react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

// --- Helpers ---

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dtfTime = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const dtfFull = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function formatRelativeTime(dateStr: string): string {
  const diffSec = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return "just now";

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");

  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, "hour");

  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return `Yesterday ${dtfTime.format(new Date(dateStr))}`;
  if (diffDay < 7) return rtf.format(-diffDay, "day");

  return dtfFull.format(new Date(dateStr));
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// --- Tool part types ---

type ToolPart = {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type === "dynamic-tool" || (part.type.startsWith("tool-") && part.type !== "tool");
}

function getToolName(part: ToolPart): string {
  if (part.toolName) return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice(5);
  return "unknown";
}

// --- Sub-components ---

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
    return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
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

function ThinkingIndicator() {
  // 3x3 grid, dots light up in sequence like a spinning pattern
  // Order: top-left → top → top-right → right → bottom-right → bottom → bottom-left → left → center
  const order = [0, 1, 2, 5, 8, 7, 6, 3, 4];
  return (
    <div className="inline-grid grid-cols-3 gap-[3px] p-1">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{
            animation: `dot-chase 1.6s ease-in-out ${order[i] * 0.15}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

function StreamingText({ text }: { text: string }) {
  const fadeLen = 25;
  if (text.length <= fadeLen) {
    return (
      <span className="streaming-fade whitespace-pre-wrap text-sm leading-relaxed">{text}</span>
    );
  }
  const stable = text.slice(0, -fadeLen);
  const fading = text.slice(-fadeLen);
  return (
    <span className="whitespace-pre-wrap text-sm leading-relaxed">
      {stable}
      <span className="streaming-fade">{fading}</span>
    </span>
  );
}

const proseClasses = "prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_table]:text-xs";

function MessageContent({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  if (isStreaming) {
    return <StreamingText text={text} />;
  }

  return (
    <div className={proseClasses}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) => <CodeBlock className={className}>{children}</CodeBlock>,
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function StatusIcon({ state }: { state: string }) {
  switch (state) {
    case "output-available":
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "output-error":
      return <X className="h-3.5 w-3.5 text-destructive" />;
    case "output-denied":
      return <X className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  }
}

function ToolInvocationCard({ part }: { part: ToolPart }) {
  const toolName = getToolName(part);
  const isError = part.state === "output-error";
  const hasOutput = part.state === "output-available";
  const hasInput = part.input !== undefined && part.input !== null;

  return (
    <Collapsible defaultOpen={false}>
      <div className="my-1.5 rounded-md border bg-background">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors [&[data-state=open]>svg.chevron]:rotate-90">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium truncate flex-1">{toolName}</span>
          <StatusIcon state={part.state} />
          <ChevronRight className="chevron h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-3 py-2 space-y-2">
            {hasInput && (
              <div>
                <span className="text-xs text-muted-foreground">Input</span>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  {formatValue(part.input)}
                </pre>
              </div>
            )}
            {hasOutput && (
              <div>
                <span className="text-xs text-muted-foreground">Result</span>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  {formatValue(part.output)}
                </pre>
              </div>
            )}
            {isError && part.errorText && (
              <div>
                <span className="text-xs text-destructive">Error</span>
                <pre className="mt-1 overflow-x-auto rounded bg-destructive/10 p-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                  {part.errorText}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// --- Main component ---

interface ChatMessageProps {
  message: UIMessage;
  isStreaming?: boolean;
}

export { ThinkingIndicator };

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";
  const metadata = message.metadata as
    | { createdAt?: string | null; platform?: string | null }
    | undefined;

  const textParts: string[] = [];
  const toolParts: ToolPart[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      textParts.push((part as { text: string }).text);
    } else if (isToolPart(part)) {
      toolParts.push(part as ToolPart);
    }
  }

  const text = textParts.join("");
  const hasContent = text || toolParts.length > 0;
  const isTelegram = metadata?.platform === "telegram";

  const [createdAt] = useState(() => metadata?.createdAt ?? new Date().toISOString());
  const timestamp = formatRelativeTime(createdAt);

  if (isUser) {
    return (
      <div className="group/msg flex justify-end px-4 py-3">
        <div className="max-w-[70%]">
          <div className="inline-block rounded-2xl bg-muted px-4 py-2 text-sm">
            {text || "..."}
          </div>
          {(timestamp || isTelegram) && (
            <div className="mt-1 flex justify-end items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/msg:opacity-100">
              {isTelegram && <Send className="h-3 w-3" />}
              {timestamp && <span>{timestamp}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg px-4 py-3">
      <div className="max-w-none">
        {hasContent ? (
          <>
            {text && <MessageContent text={text} isStreaming={isStreaming} />}
            {toolParts.map((part) => (
              <ToolInvocationCard key={part.toolCallId} part={part} />
            ))}
          </>
        ) : isStreaming ? (
          <ThinkingIndicator />
        ) : (
          <span className="text-muted-foreground text-sm">...</span>
        )}
        {(timestamp || isTelegram) && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/msg:opacity-100">
            {isTelegram && <Send className="h-3 w-3" />}
            {timestamp && <span>{timestamp}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
