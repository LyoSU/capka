import { type UIMessage } from "ai";
import {
  Copy, Check, Send,
  ChevronRight, Loader2, CheckCircle2, AlertCircle,
  FileSearch, Globe, Terminal, Folder,
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

// --- Tool types ---

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

// Friendly tool display name + icon
function getToolDisplay(name: string): { label: string; icon: typeof Terminal } {
  const lower = name.toLowerCase();
  if (lower.includes("read") || lower.includes("file")) return { label: "Reading file", icon: FileSearch };
  if (lower.includes("list") || lower.includes("dir")) return { label: "Listing directory", icon: Folder };
  if (lower.includes("search") || lower.includes("web")) return { label: "Searching web", icon: Globe };
  if (lower.includes("write") || lower.includes("edit")) return { label: "Writing file", icon: FileSearch };
  // Default: clean up the tool name
  const clean = name.replace(/^filesystem_/, "").replace(/_/g, " ");
  return { label: clean, icon: Terminal };
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
  const order = [0, 1, 2, 5, 8, 7, 6, 3, 4];
  return (
    <div className="inline-grid grid-cols-3 gap-[3px] p-1">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-foreground/60"
          style={{ animation: `dot-chase 1.6s ease-in-out ${order[i] * 0.15}s infinite` }}
        />
      ))}
    </div>
  );
}

function StreamingText({ text }: { text: string }) {
  const fadeLen = 25;
  if (text.length <= fadeLen) {
    return <span className="streaming-fade whitespace-pre-wrap text-sm leading-relaxed">{text}</span>;
  }
  const stable = text.slice(0, -fadeLen);
  const fading = text.slice(-fadeLen);
  return (
    <span className="whitespace-pre-wrap text-sm leading-relaxed">
      {stable}<span className="streaming-fade">{fading}</span>
    </span>
  );
}

const proseClasses = "prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_table]:text-xs";

function TextContent({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  if (isStreaming) return <StreamingText text={text} />;
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

function ToolCard({ part }: { part: ToolPart }) {
  const rawName = getToolName(part);
  const { label, icon: Icon } = getToolDisplay(rawName);
  const isRunning = !part.state.startsWith("output-");
  const isError = part.state === "output-error";
  const isDone = part.state === "output-available";
  const hasInput = part.input !== undefined && part.input !== null;
  const hasOutput = isDone && part.output !== undefined;

  // Compact inline display for running tools
  if (isRunning) {
    return (
      <div className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <Icon className="h-3 w-3" />
        <span>{label}</span>
        {hasInput && (
          <span className="truncate max-w-60 font-mono text-[10px] opacity-60">
            {typeof part.input === "object" ? Object.values(part.input as Record<string, unknown>).join(", ") : String(part.input)}
          </span>
        )}
      </div>
    );
  }

  // Completed tool — collapsible with result
  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors group/tool [&[data-state=open]>.chevron]:rotate-90">
        {isError ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500/70" />
        )}
        <Icon className="h-3 w-3 shrink-0" />
        <span className="flex-1 text-left truncate">{label}</span>
        {hasInput && (
          <span className="truncate max-w-40 font-mono text-[10px] opacity-50 group-hover/tool:opacity-70">
            {typeof part.input === "object"
              ? Object.values(part.input as Record<string, unknown>)[0] as string
              : String(part.input)}
          </span>
        )}
        <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mb-2 space-y-1.5 border-l-2 border-border/50 pl-3">
          {hasInput && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Input</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-muted/50 px-2 py-1.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                {formatValue(part.input)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Result</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-muted/50 px-2 py-1.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all text-muted-foreground max-h-40 overflow-y-auto">
                {formatValue(part.output)}
              </pre>
            </div>
          )}
          {isError && part.errorText && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-destructive/60">Error</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-destructive/5 px-2 py-1.5 text-[11px] font-mono text-destructive whitespace-pre-wrap break-all">
                {part.errorText}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TimestampRow({ timestamp, isTelegram }: { timestamp: string; isTelegram: boolean }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/msg:opacity-100">
      {isTelegram && <Send className="h-3 w-3" />}
      <span>{timestamp}</span>
    </div>
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

  const [createdAt] = useState(() => metadata?.createdAt ?? new Date().toISOString());
  const timestamp = formatRelativeTime(createdAt);
  const isTelegram = metadata?.platform === "telegram";

  if (isUser) {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    return (
      <div className="group/msg flex justify-end px-4 py-3">
        <div className="max-w-[70%]">
          <div className="inline-block rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 text-sm">
            {text || "..."}
          </div>
          <div className="mt-1 flex justify-end">
            <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />
          </div>
        </div>
      </div>
    );
  }

  // Assistant — render parts in original order
  const parts = message.parts;
  const hasAnyContent = parts.length > 0;

  return (
    <div className="group/msg px-4 py-3">
      <div className="max-w-none">
        {hasAnyContent ? (
          parts.map((part, i) => {
            if (part.type === "text") {
              const text = (part as { text: string }).text;
              if (!text) return null;
              const isLast = i === parts.length - 1 || parts.slice(i + 1).every((p) => p.type !== "text");
              return <TextContent key={i} text={text} isStreaming={isStreaming && isLast} />;
            }
            if (isToolPart(part)) {
              return <ToolCard key={(part as ToolPart).toolCallId} part={part as ToolPart} />;
            }
            return null;
          })
        ) : isStreaming ? (
          <ThinkingIndicator />
        ) : (
          <span className="text-muted-foreground text-sm">...</span>
        )}
        <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />
      </div>
    </div>
  );
}
