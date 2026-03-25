import { type UIMessage } from "ai";
import { Fragment } from "react";
import {
  Copy, Check, Send, Download,
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
    if (!value.trim()) return "";
    try {
      return formatValue(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (typeof value !== "object") return String(value);

  const obj = value as Record<string, unknown>;

  // MCP format: { structuredContent: { content: "..." } } or { structuredContent: { ... } }
  if (obj.structuredContent && typeof obj.structuredContent === "object") {
    const sc = obj.structuredContent as Record<string, unknown>;
    if (typeof sc.content === "string" && sc.content.trim()) return sc.content;
    if (typeof sc.text === "string" && sc.text.trim()) return sc.text;
    // structuredContent without content/text — stringify the whole thing
    const scStr = JSON.stringify(sc, null, 2);
    if (scStr !== "{}") return scStr;
  }
  // MCP format: { content: [{ text: "...", type: "text" }] }
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as { text?: string; type?: string }[])
      .filter((c) => c.type === "text" && c.text?.trim())
      .map((c) => c.text!);
    if (texts.length > 0) return texts.join("\n");
  }
  // Common fields
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  if (typeof obj.result === "string" && obj.result.trim()) return obj.result;
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message;

  // If isError is false and everything is empty, it's just a success with no output
  if (obj.isError === false) return "";

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

// --- Tool detail renderer ---

function ToolDetails({ toolName, output, errorText }: { toolName: string; output?: unknown; errorText?: string }) {
  if (errorText) {
    return <p className="text-xs text-destructive/80">{errorText}</p>;
  }

  const text = formatValue(output);
  if (!text) return <p className="text-xs text-muted-foreground/50">Done</p>;

  const lower = toolName.toLowerCase();
  const isCode = lower.includes("read") || lower.includes("file");
  const isCommand = lower.includes("exec") || lower.includes("run") || lower.includes("shell");
  const isListing = lower.includes("list") || lower.includes("dir");

  // File content — show as code
  if (isCode && text.length > 50) {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed max-h-48 overflow-y-auto">
        {text.slice(0, 3000)}{text.length > 3000 ? "\n..." : ""}
      </pre>
    );
  }

  // Command output — terminal style
  if (isCommand) {
    return (
      <pre className="overflow-x-auto rounded-md bg-foreground/5 p-2.5 font-mono text-[11px] leading-relaxed max-h-36 overflow-y-auto text-muted-foreground">
        {text.slice(0, 2000)}{text.length > 2000 ? "\n..." : ""}
      </pre>
    );
  }

  // Directory listing — clean text list
  if (isListing) {
    const lines = text.split("\n").filter(Boolean);
    const shown = lines.slice(0, 20);
    return (
      <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
        {shown.join("\n")}
        {lines.length > 20 && `\n… +${lines.length - 20} more`}
      </div>
    );
  }

  // Default — clean readable text
  return (
    <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto">
      {text.slice(0, 2000)}{text.length > 2000 ? "..." : ""}
    </div>
  );
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

/** Close open markdown tags so partial streaming text renders correctly */
function closeOpenMarkdown(text: string): string {
  // Each check fixes the highest-priority unclosed tag and returns early
  // to avoid scanning inside already-open blocks (e.g. * inside code fences)
  const fenceCount = (text.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) return text + "\n```";

  const backtickCount = (text.match(/(?<!`)`(?!`)/g) || []).length;
  if (backtickCount % 2 !== 0) return text + "`";

  const boldCount = (text.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) return text + "**";

  const italicCount = (text.match(/(?<!\*)\*(?!\*)/g) || []).length;
  if (italicCount % 2 !== 0) return text + "*";

  return text;
}

const proseClasses = "prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_table]:text-xs";

function TextContent({ text, isStreaming, chatId }: { text: string; isStreaming?: boolean; chatId?: string }) {
  const md = isStreaming ? closeOpenMarkdown(text) : text;
  return (
    <div className={`${proseClasses}${isStreaming ? " streaming-text" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) => {
            if (!className && chatId && typeof children === "string" && children.startsWith("/workspace/")) {
              return <DownloadLink chatId={chatId} filePath={children.replace(/^\/workspace\//, "")} />;
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          pre: ({ children }) => <>{children}</>,
          p: ({ children }) => {
            if (!chatId) return <p>{children}</p>;
            return <p>{processWorkspacePaths(children, chatId)}</p>;
          },
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}

const downloadLinkClass = "inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary no-underline hover:bg-primary/20 transition-colors";

function DownloadLink({ chatId, filePath }: { chatId: string; filePath: string }) {
  const fileName = filePath.split("/").pop() || filePath;
  return (
    <a
      href={`/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(filePath)}`}
      download={fileName}
      className={downloadLinkClass}
    >
      <Download className="h-3 w-3" />
      {fileName}
    </a>
  );
}

/** Convert /workspace/... paths in text nodes to download links */
function processWorkspacePaths(children: React.ReactNode, chatId: string): React.ReactNode {
  if (!Array.isArray(children)) {
    if (typeof children !== "string") return children;
    return replacePathsInText(children, chatId);
  }
  return children.map((child, i) => {
    if (typeof child === "string") return <Fragment key={i}>{replacePathsInText(child, chatId)}</Fragment>;
    return child;
  });
}

function replacePathsInText(text: string, chatId: string): React.ReactNode {
  const regex = /\/workspace\/([\w/.А-Яа-яІіЇїЄєҐґ_\-\s()]+\.\w+)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<DownloadLink key={match.index} chatId={chatId} filePath={match[1]} />);
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
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
        {summary && <span className="truncate max-w-40 text-xs text-muted-foreground/40">{summary}</span>}
      </div>
    );
  }

  // Error — expandable with real error text
  if (isError) {
    return (
      <Collapsible defaultOpen={!!part.errorText}>
        <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-1.5 py-0.5 text-xs text-destructive/70 hover:text-destructive transition-colors [&[data-state=open]>.chevron]:rotate-90">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="flex-1 text-left">{label} failed</span>
          <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 mb-2 ml-5 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive/80">
            {part.errorText || "Unknown error"}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // Done — full-width row, expandable
  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors [&[data-state=open]>.chevron]:rotate-90">
        <Icon className="h-3 w-3 shrink-0" />
        <span>{label}</span>
        {summary && <span className="flex-1 truncate text-muted-foreground/40">{summary}</span>}
        <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-2 ml-5 rounded-lg border border-border/40 bg-card p-3">
          <ToolDetails toolName={rawName} output={part.output} errorText={part.errorText} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Groups consecutive tool calls into a collapsible summary */
function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const allDone = tools.every((t) => t.state.startsWith("output-"));
  const hasError = tools.some((t) => t.state === "output-error");
  const running = tools.filter((t) => !t.state.startsWith("output-"));

  // Single tool — render directly
  if (tools.length === 1) return <ToolCard part={tools[0]} />;

  // Multiple tools still running
  if (!allDone && running.length > 0) {
    const last = running[running.length - 1];
    const { activeLabel } = getToolDisplay(getToolName(last));
    return (
      <div className="my-1 flex items-center gap-2 py-0.5 text-muted-foreground/70">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-xs">{activeLabel}</span>
        <span className="text-xs text-muted-foreground/40">({tools.length} steps)</span>
      </div>
    );
  }

  // All done — collapsible with inline tool names
  const uniqueLabels = [...new Set(tools.map((t) => getToolDisplay(getToolName(t)).label))];
  const summaryText = uniqueLabels.length <= 3
    ? uniqueLabels.join(", ")
    : `${uniqueLabels.slice(0, 2).join(", ")} +${uniqueLabels.length - 2} more`;

  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors [&[data-state=open]>.chevron]:rotate-90">
        {hasError && <AlertCircle className="h-3 w-3 shrink-0 text-destructive/60" />}
        <span>{summaryText}</span>
        <span className="text-muted-foreground/30">{tools.length} steps</span>
        <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-2 space-y-0">
          {tools.map((t) => (
            <ToolCard key={t.toolCallId} part={t} />
          ))}
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
  chatId?: string;
}

export { ThinkingIndicator };

export function ChatMessage({ message, isStreaming, chatId }: ChatMessageProps) {
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

  // Assistant — group consecutive parts by kind
  const parts = message.parts;
  type Group = { kind: "text"; text: string } | { kind: "tools"; tools: ToolPart[] };
  const groups: Group[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = (part as { text: string }).text;
      if (text) groups.push({ kind: "text", text });
    } else if (isToolPart(part)) {
      const last = groups[groups.length - 1];
      if (last?.kind === "tools") last.tools.push(part as ToolPart);
      else groups.push({ kind: "tools", tools: [part as ToolPart] });
    }
  }
  const lastTextIdx = groups.reduce((acc, g, i) => g.kind === "text" ? i : acc, -1);

  return (
    <div className="group/msg px-4 py-3">
      <div className="max-w-none">
        {groups.length > 0 ? (
          groups.map((g, gi) => {
            if (g.kind === "text") {
              const afterTools = gi > 0 && groups[gi - 1].kind === "tools";
              return (
                <div key={gi} className={afterTools ? "mt-3 pt-3 border-t border-border/30" : ""}>
                  <TextContent text={g.text} isStreaming={isStreaming && gi === lastTextIdx} chatId={chatId} />
                </div>
              );
            }
            const afterText = gi > 0 && groups[gi - 1].kind === "text";
            return (
              <div key={gi} className={`${afterText ? "mt-2" : ""} rounded-lg bg-muted/30 px-3 py-2`}>
                <ToolGroup tools={g.tools} />
              </div>
            );
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
