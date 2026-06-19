import { type UIMessage } from "ai";
import {
  Send, Download, Copy, Check,
  ChevronRight, Loader2, AlertCircle, Brain,
} from "lucide-react";
import { Markdown } from "@/components/chat/markdown";
import { haptic } from "@/lib/haptics";
import { useState, useMemo, memo } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { fileKind, extOf } from "@/lib/file-kinds";
import { describeStep } from "./steps";

// --- Helpers ---

// LLM error categories that have an errors.llm.<category> translation. The
// server stores the category in message metadata; the user-facing text is
// rendered here (localized) instead of the English string baked in at runtime.
const LLM_ERROR_CATEGORIES = new Set([
  "out_of_credits", "invalid_key", "rate_limited", "model_unavailable",
  "context_too_long", "network", "timed_out", "unknown",
]);

type TimeTranslator = (key: string, values?: Record<string, string | number>) => string;

/** Locale-aware relative timestamp. Intl formatters are built per call from the
 *  active locale so the same component reads "2 hours ago" or "2 години тому". */
function formatRelativeTime(dateStr: string, locale: string, t: TimeTranslator): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const date = new Date(dateStr);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return t("justNow");
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) {
    const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
    return t("yesterday", { time });
  }
  if (diffDay < 7) return rtf.format(-diffDay, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
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

  // unClaw sandbox tool shapes — show the human-meaningful field, never the
  // raw { output, exitCode, success } wrapper (that JSON is dev noise).
  if (typeof obj.output === "string") return obj.output.trim(); // execute_bash/python/node
  if (typeof obj.listing === "string") return obj.listing.trim(); // list_files
  if (typeof obj.matches === "string") return obj.matches.trim(); // search_files
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error; // tool-reported error
  if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
    return [obj.stdout, obj.stderr].filter((s) => typeof s === "string" && s.trim()).join("\n");
  }
  // write_file / str_replace success: { success: true, path } — no body to show.
  if (obj.success === true) return "";

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

// --- Tool detail renderer ---

function ToolDetails({ toolName, output, errorText }: { toolName: string; output?: unknown; errorText?: string }) {
  const t = useTranslations("chat.tool");
  if (errorText) {
    return <p className="text-xs text-destructive">{errorText}</p>;
  }

  const text = formatValue(output);
  if (!text) return <p className="text-xs text-muted-foreground">{t("done")}</p>;

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
        {lines.length > 20 && `\n… ${t("more", { count: lines.length - 20 })}`}
      </div>
    );
  }

  // Default — clean readable text
  return (
    <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto">
      {text.slice(0, 2000)}{text.length > 2000 ? "…" : ""}
    </div>
  );
}

// --- Sub-components ---



function TextContent({ text, isStreaming, chatId }: { text: string; isStreaming?: boolean; chatId?: string }) {
  return (
    <div className="text-[15px] leading-relaxed">
      <Markdown isStreaming={isStreaming}>{text}</Markdown>
      {isStreaming && (
        // A soft blinking caret so the reply reads as "still being written".
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-pulse rounded-full bg-foreground/50"
        />
      )}
      {chatId && <WorkspaceLinks text={text} chatId={chatId} />}
    </div>
  );
}

const WORKSPACE_PATH_RE = /\/workspace\/((?:(?!\/workspace\/)[\w/.А-Яа-яІіЇїЄєҐґ_\- ()])+\.\w+)/g;

function WorkspaceLinks({ text, chatId }: { text: string; chatId: string }) {
  const t = useTranslations("chat.tool");
  const tw = useTranslations("chat.workspace");
  // Re-scanning the message text on every render is wasteful; the artifact
  // paths only change when the text does.
  const paths = useMemo(
    () => [...new Set(Array.from(text.matchAll(WORKSPACE_PATH_RE), (m) => m[1]))],
    [text],
  );
  if (paths.length === 0) return null;

  const downloadAll = () => {
    const params = new URLSearchParams({ chatId });
    paths.forEach((p) => params.append("paths", p));
    const a = document.createElement("a");
    a.href = `/api/sandbox/files/download-all?${params}`;
    a.download = "workspace-files.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border/50">
      <div className="flex items-center justify-between bg-muted/30 px-4 py-2.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("artifacts", { count: paths.length })}
        </span>
        {paths.length > 1 && (
          <button
            type="button"
            onClick={downloadAll}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            <span>{tw("downloadAll")}</span>
          </button>
        )}
      </div>
      <div className="divide-y divide-border/25">
        {paths.map((p) => {
          const fileName = p.split("/").pop() || p;
          const ext = extOf(fileName);
          const { label, Icon, color, bg } = fileKind(fileName);
          return (
            <a
              key={p}
              href={`/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(p)}`}
              download={fileName}
              className="group/file flex items-center gap-3.5 px-4 py-3 no-underline transition-colors hover:bg-accent/50"
            >
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-[18px] w-[18px] ${color}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-snug text-foreground">{fileName}</p>
                <p className="text-xs text-muted-foreground">{label} · {ext.toUpperCase()}</p>
              </div>
              <Download className="h-4 w-4 shrink-0 text-muted-foreground/20 transition-colors group-hover/file:text-muted-foreground" />
            </a>
          );
        })}
      </div>
    </div>
  );
}


/** The model's reasoning — a quiet, collapsible "thinking" block (shown only
 *  when the provider streams reasoning). Brain glyph + a muted italic preview
 *  that expands to the full thought, so it informs without shouting. */
function ReasoningBlock({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const t = useTranslations("chat.message");
  const preview = text.trim().replace(/\s+/g, " ");
  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-2 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>.chevron]:rotate-90">
        <Brain className={`h-3.5 w-3.5 shrink-0 ${isStreaming ? "animate-pulse" : ""}`} />
        <span className="flex-1 truncate italic">{preview || t("thinking")}</span>
        <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 mb-2 ml-[1.375rem] whitespace-pre-wrap text-[13px] italic leading-relaxed text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCard({ part }: { part: ToolPart }) {
  const tSteps = useTranslations("steps");
  const t = useTranslations("chat.tool");
  const rawName = getToolName(part);
  const { label, activeLabel, detail, Icon } = describeStep(tSteps, rawName, part.input);
  const isRunning = !part.state.startsWith("output-");
  const isError = part.state === "output-error";

  // Running — subtle inline with spinner
  if (isRunning) {
    return (
      <div className="my-1 flex items-center gap-2 py-0.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-xs">{activeLabel}</span>
        {detail && <span className="truncate max-w-40 font-mono text-[11px] text-muted-foreground">{detail}</span>}
      </div>
    );
  }

  // Error — expandable with real error text
  if (isError) {
    return (
      <Collapsible defaultOpen={!!part.errorText}>
        <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-1.5 py-0.5 text-xs text-destructive hover:text-destructive transition-colors [&[data-state=open]>.chevron]:rotate-90">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="flex-1 text-left">{label} · {t("failed")}</span>
          <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 mb-2 ml-5 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
            {part.errorText || t("unknownError")}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // Done — full-width row, expandable
  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>.chevron]:rotate-90">
        <Icon className="h-3 w-3 shrink-0" />
        <span>{label}</span>
        {detail && <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">{detail}</span>}
        <ChevronRight className="chevron h-3 w-3 shrink-0 opacity-40 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-2 ml-[1.375rem] rounded-lg bg-muted/40 p-2.5">
          <ToolDetails toolName={rawName} output={part.output} errorText={part.errorText} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Groups consecutive tool calls into a collapsible summary */
function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const tSteps = useTranslations("steps");
  const tTool = useTranslations("chat.tool");
  const allDone = tools.every((t) => t.state.startsWith("output-"));
  const hasError = tools.some((t) => t.state === "output-error");
  const running = tools.filter((t) => !t.state.startsWith("output-"));

  // Single tool — render directly
  if (tools.length === 1) return <ToolCard part={tools[0]} />;

  // Multiple tools still running
  if (!allDone && running.length > 0) {
    const last = running[running.length - 1];
    const { activeLabel } = describeStep(tSteps, getToolName(last), last.input);
    return (
      <div className="my-1 flex items-center gap-2 py-0.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-xs">{activeLabel}</span>
        <span className="text-xs text-muted-foreground">({tTool("steps", { count: tools.length })})</span>
      </div>
    );
  }

  // All done — collapsible with inline step labels
  const uniqueLabels = [...new Set(tools.map((t) => describeStep(tSteps, getToolName(t), t.input).label))];
  const summaryText = uniqueLabels.length <= 3
    ? uniqueLabels.join(", ")
    : `${uniqueLabels.slice(0, 2).join(", ")} ${tTool("more", { count: uniqueLabels.length - 2 })}`;

  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="my-0.5 flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>.chevron]:rotate-90">
        {hasError && <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />}
        <span>{summaryText}</span>
        <span className="text-muted-foreground">{tTool("steps", { count: tools.length })}</span>
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

/** Friendly, role-aware failure notice. Everyone sees `message`; admins can
 *  expand the raw technical `detail`. */
function ErrorNotice({ message, detail, isAdmin }: { message: string; detail?: string; isAdmin?: boolean }) {
  const t = useTranslations("chat.tool");
  return (
    <div role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5">
      <div className="flex items-start gap-2 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="flex-1">{message}</span>
      </div>
      {isAdmin && detail && detail !== message && (
        <Collapsible>
          <CollapsibleTrigger className="mt-1.5 ml-6 flex items-center gap-1 text-xs text-destructive/60 hover:text-destructive transition-colors [&[data-state=open]>.chevron]:rotate-90">
            <ChevronRight className="chevron h-3 w-3 transition-transform" />
            {t("technicalDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 ml-6 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/5 p-2 font-mono text-[11px] text-destructive/70">
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** Hover-revealed "copy" action for an assistant reply. Swaps to a check for a
 *  beat on success and fires a light haptic — quiet until the user reaches for it. */
function CopyButton({ text }: { text: string }) {
  const t = useTranslations("chat.message");
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      haptic("tap");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context / permissions) — fail quietly */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? t("copied") : t("copy")}
      aria-label={copied ? t("copied") : t("copy")}
      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function TimestampRow({ timestamp, isTelegram }: { timestamp: string; isTelegram: boolean }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground opacity-60 sm:opacity-0 transition-opacity duration-200 sm:group-hover/msg:opacity-100">
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
  isAdmin?: boolean;
}

function ChatMessageImpl({ message, isStreaming, chatId, statusSlot, isAdmin }: ChatMessageProps) {
  const locale = useLocale();
  const t = useTranslations("chat.message");
  const tTime = useTranslations("chat.time");
  const tErr = useTranslations("errors.llm");
  const isUser = message.role === "user";
  const metadata = message.metadata as
    | { createdAt?: string | null; platform?: string | null; taskStatus?: string | null; error?: string | null; errorDetail?: string | null; errorCategory?: string | null }
    | undefined;

  const [createdAt] = useState(() => metadata?.createdAt ?? new Date().toISOString());
  const timestamp = formatRelativeTime(createdAt, locale, tTime);
  const isTelegram = metadata?.platform === "telegram";

  if (isUser) {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    return (
      <div className="group/msg flex animate-blur-rise justify-end px-4 md:px-6 py-4">
        <div className="max-w-[75%] lg:max-w-[65%]">
          <div className="inline-block whitespace-pre-wrap break-words rounded-2xl bg-primary text-primary-foreground px-5 py-3 text-[15px]">
            {text || "…"}
          </div>
          <div className="mt-1 flex justify-end">
            <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />
          </div>
        </div>
      </div>
    );
  }

  // Assistant — group consecutive parts by kind (text, the model's reasoning,
  // and runs of tool calls), so the transcript reads as a sequence of steps.
  const parts = message.parts;
  type Group =
    | { kind: "text"; text: string }
    | { kind: "tools"; tools: ToolPart[] }
    | { kind: "reasoning"; text: string };
  const groups: Group[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = (part as { text: string }).text;
      if (text) groups.push({ kind: "text", text });
    } else if (part.type === "reasoning") {
      const text = (part as { text: string }).text;
      if (text) {
        const last = groups[groups.length - 1];
        if (last?.kind === "reasoning") last.text += text;
        else groups.push({ kind: "reasoning", text });
      }
    } else if (isToolPart(part)) {
      const last = groups[groups.length - 1];
      if (last?.kind === "tools") last.tools.push(part as ToolPart);
      else groups.push({ kind: "tools", tools: [part as ToolPart] });
    }
  }
  const lastTextIdx = groups.reduce((acc, g, i) => g.kind === "text" ? i : acc, -1);
  const lastIdx = groups.length - 1;

  return (
    <div className="group/msg px-4 md:px-6 py-4">
      <div className="max-w-none">
        {groups.length > 0 ? (
          groups.map((g, gi) => {
            // Each part animates in on mount (blur-rise) — new steps and text
            // surface live as they stream, so the message feels alive.
            if (g.kind === "text") {
              const afterActivity = gi > 0 && groups[gi - 1].kind !== "text";
              return (
                <div key={gi} className={`animate-blur-rise ${afterActivity ? "mt-3 border-t border-border/30 pt-3" : gi > 0 ? "mt-3" : ""}`}>
                  <TextContent text={g.text} isStreaming={isStreaming && gi === lastTextIdx} chatId={chatId} />
                </div>
              );
            }
            if (g.kind === "reasoning") {
              return (
                <div key={gi} className={`animate-blur-rise ${gi > 0 ? "mt-1.5" : ""}`}>
                  <ReasoningBlock text={g.text} isStreaming={isStreaming && gi === lastIdx} />
                </div>
              );
            }
            return (
              <div key={gi} className={`animate-blur-rise ${gi > 0 ? "mt-1.5" : ""}`}>
                <ToolGroup tools={g.tools} />
              </div>
            );
          })
        ) : isStreaming || metadata?.taskStatus === "failed" ? null : (
          <span className="text-muted-foreground text-sm">
            {metadata?.taskStatus === "cancelled" ? t("cancelled") : "…"}
          </span>
        )}
        {metadata?.taskStatus === "failed" && (
          <ErrorNotice
            message={
              metadata.errorCategory && LLM_ERROR_CATEGORIES.has(metadata.errorCategory)
                ? tErr(metadata.errorCategory)
                : metadata.error || t("genericError")
            }
            detail={metadata.errorDetail || undefined}
            isAdmin={isAdmin}
          />
        )}
        {statusSlot}
        {!isStreaming && (() => {
          const copyText = groups.filter((g) => g.kind === "text").map((g) => g.text).join("\n\n").trim();
          return (
            <div className="mt-1 flex items-center gap-1">
              {copyText && <CopyButton text={copyText} />}
              <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// Memoized: with stable message identities (state changes only mutate the one
// streaming message), keystrokes in the input and tokens for OTHER messages no
// longer re-render the whole history.
export const ChatMessage = memo(ChatMessageImpl);
