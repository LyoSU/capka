import { type UIMessage } from "ai";
import {
  Copy, Check, Send,
  ChevronRight, Loader2, AlertCircle,
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

/** Extract human-readable text from tool output (handles MCP nested formats) */
function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    try {
      return formatValue(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (typeof value !== "object") return String(value);

  const obj = value as Record<string, unknown>;

  // MCP format: { structuredContent: { content: "..." } }
  if (obj.structuredContent && typeof obj.structuredContent === "object") {
    const sc = obj.structuredContent as Record<string, unknown>;
    if (sc.content) return String(sc.content);
  }
  // MCP format: { content: [{ text: "...", type: "text" }] }
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as { text?: string; type?: string }[])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  // Common fields
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.message === "string") return obj.message;

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

// Friendly tool display — human-readable labels
function getToolDisplay(name: string): { label: string; activeLabel: string; icon: typeof Terminal } {
  const lower = name.toLowerCase();
  if (lower.includes("read") || lower.includes("file_read")) return { label: "Read a file", activeLabel: "Reading file...", icon: FileSearch };
  if (lower.includes("list") || lower.includes("dir")) return { label: "Browsed files", activeLabel: "Browsing files...", icon: Folder };
  if (lower.includes("search") || lower.includes("web")) return { label: "Searched the web", activeLabel: "Searching...", icon: Globe };
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create")) return { label: "Wrote a file", activeLabel: "Writing...", icon: FileSearch };
  if (lower.includes("exec") || lower.includes("run") || lower.includes("shell")) return { label: "Ran a command", activeLabel: "Running...", icon: Terminal };
  const clean = name.replace(/^filesystem_/, "").replace(/_/g, " ");
  return { label: clean, activeLabel: `${clean}...`, icon: Terminal };
}

function getInputSummary(input: unknown): string | null {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : null;
  const obj = input as Record<string, unknown>;
  // Show the most meaningful field
  if (obj.path) return String(obj.path);
  if (obj.query) return String(obj.query);
  if (obj.command) return String(obj.command).slice(0, 60);
  if (obj.url) return String(obj.url);
  const first = Object.values(obj)[0];
  return first ? String(first).slice(0, 60) : null;
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
  const { label, activeLabel, icon: Icon } = getToolDisplay(rawName);
  const isRunning = !part.state.startsWith("output-");
  const isError = part.state === "output-error";
  const summary = getInputSummary(part.input);

  // Running — subtle inline with spinner
  if (isRunning) {
    return (
      <div className="my-1 flex items-center gap-2 py-0.5 text-muted-foreground/70">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-xs">{activeLabel}</span>
      </div>
    );
  }

  // Error — show inline
  if (isError) {
    return (
      <div className="my-1 flex items-center gap-2 py-0.5 text-destructive/70">
        <AlertCircle className="h-3 w-3" />
        <span className="text-xs">Something went wrong</span>
      </div>
    );
  }

  // Done — single line, expandable on click
  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-0.5 flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors group/tool [&[data-state=open]>.chevron]:rotate-90">
        <Icon className="h-3 w-3 shrink-0" />
        <span>{label}</span>
        {summary && <span className="truncate max-w-48 opacity-60">{summary}</span>}
        <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-0 group-hover/tool:opacity-40 transition-all" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-2 ml-5 max-h-32 overflow-y-auto rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
          <pre className="whitespace-pre-wrap break-words">{formatValue(part.output)}</pre>
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
