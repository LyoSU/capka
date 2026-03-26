import { type UIMessage } from "ai";
import {
  Send, Download,
  ChevronRight, Loader2, AlertCircle,
  FileSearch, Globe, Terminal, Folder,
} from "lucide-react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useState } from "react";
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

// Tool display config — keyword patterns → human-friendly labels
const TOOL_PATTERNS: { keywords: string[]; label: string; activeLabel: string; icon: typeof Terminal }[] = [
  { keywords: ["read", "file_read"],                   label: "Looked at a file",  activeLabel: "Reading...",          icon: FileSearch },
  { keywords: ["list", "dir"],                         label: "Browsed files",     activeLabel: "Looking at files...", icon: Folder },
  { keywords: ["search", "web"],                       label: "Searched the web",  activeLabel: "Searching...",        icon: Globe },
  { keywords: ["write", "edit", "create"],             label: "Created a file",    activeLabel: "Writing...",          icon: FileSearch },
  { keywords: ["exec", "run", "shell", "bash", "python"], label: "Ran some code",  activeLabel: "Working...",         icon: Terminal },
];
const TOOL_FALLBACK = { label: "Used a tool", activeLabel: "Working...", icon: Terminal };

function getToolDisplay(name: string) {
  const lower = name.toLowerCase();
  return TOOL_PATTERNS.find((p) => p.keywords.some((k) => lower.includes(k))) ?? TOOL_FALLBACK;
}

/** Extract a short, user-friendly hint from tool input — just file names or search queries */
function getInputSummary(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (obj.path) return String(obj.path).split("/").pop() || null;
  if (obj.query) return String(obj.query).slice(0, 50);
  return null;
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



function TextContent({ text, isStreaming, chatId }: { text: string; isStreaming?: boolean; chatId?: string }) {
  return (
    <div className="text-[15px] leading-relaxed">
      <Streamdown
        parseIncompleteMarkdown={isStreaming}
        shikiTheme={["github-light", "github-dark"]}
        controls={{ code: { copy: true }, table: { copy: true, download: true, fullscreen: true } }}
      >
        {text}
      </Streamdown>
      {chatId && <WorkspaceLinks text={text} chatId={chatId} />}
    </div>
  );
}

const WORKSPACE_PATH_RE = /\/workspace\/([\w/.А-Яа-яІіЇїЄєҐґ_\-\s()]+\.\w+)/g;

function WorkspaceLinks({ text, chatId }: { text: string; chatId: string }) {
  const paths = Array.from(text.matchAll(WORKSPACE_PATH_RE), (m) => m[1]);
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {paths.map((p) => <DownloadLink key={p} chatId={chatId} filePath={p} />)}
    </div>
  );
}

function DownloadLink({ chatId, filePath }: { chatId: string; filePath: string }) {
  const fileName = filePath.split("/").pop() || filePath;
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const isImage = ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext);
  const label = isImage ? "Image" : ext.toUpperCase();
  return (
    <a
      href={`/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(filePath)}`}
      download={fileName}
      className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium text-foreground no-underline shadow-sm hover:bg-accent transition-colors"
    >
      <Download className="h-4 w-4 text-muted-foreground" />
      <span className="truncate max-w-48">{fileName}</span>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{label}</span>
    </a>
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
  statusSlot?: React.ReactNode;
}

export function ChatMessage({ message, isStreaming, chatId, statusSlot }: ChatMessageProps) {
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
      <div className="group/msg flex justify-end px-4 md:px-6 py-4">
        <div className="max-w-[75%] lg:max-w-[65%]">
          <div className="inline-block rounded-2xl bg-primary text-primary-foreground px-5 py-3 text-[15px]">
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
    <div className="group/msg px-4 md:px-6 py-4">
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
        ) : isStreaming ? null : (
          <span className="text-muted-foreground text-sm">...</span>
        )}
        {statusSlot}
        {!isStreaming && <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />}
      </div>
    </div>
  );
}
