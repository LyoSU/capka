import { type UIMessage } from "ai";
import {
  Send, Download, Copy, Check, RotateCcw, Pencil,
  ChevronLeft, ChevronRight, GitBranch, AlertCircle, Lightbulb, Info, AlertTriangle,
} from "lucide-react";
import { ModelPicker } from "@/components/chat/model-picker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Markdown } from "@/components/chat/markdown";
import { haptic } from "@/lib/haptics";
import { useLongPress } from "@/hooks/use-long-press";
import { useState, useMemo, useEffect, useRef, memo } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { previewKind } from "@/lib/file-kinds";
import { extractWorkspacePaths } from "@/lib/chat/artifacts";
import { cleanReasoning } from "@/lib/chat/reasoning";
import { formatShortDuration } from "@/lib/chat/duration";
import { SandboxFileTile, type PreviewFile } from "./file-preview";
import { describeStep, type StepDescriptor } from "./steps";

// --- Helpers ---

// LLM error categories that have an errors.llm.<category> translation. The
// server stores the category in message metadata; the user-facing text is
// rendered here (localized) instead of the English string baked in at runtime.
const LLM_ERROR_CATEGORIES = new Set([
  "out_of_credits", "invalid_key", "rate_limited", "model_unavailable",
  "context_too_long", "network", "timed_out", "interrupted", "unknown",
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
  // `chat-prose` caps flowing text to a ~70ch measure (see globals.css) so long
  // answers stay in the comfortable reading band; code blocks and tables are
  // exempt and keep the full column width. 16px (text-base) is the readable
  // floor — 15px sat just under it for Cyrillic body with tall diacritics.
  return (
    <div className="chat-prose text-base leading-relaxed">
      <Markdown isStreaming={isStreaming} chatId={chatId}>{text}</Markdown>
      {chatId && <WorkspaceLinks text={text} chatId={chatId} live={isStreaming} />}
    </div>
  );
}

function WorkspaceLinks({ text, chatId, live }: { text: string; chatId: string; live?: boolean }) {
  const t = useTranslations("chat.tool");
  const tw = useTranslations("chat.workspace");
  // Re-scanning the message text on every render is wasteful; the artifact
  // paths only change when the text does. Shared with the Telegram channel so
  // both surface the same referenced files.
  const paths = useMemo(() => extractWorkspacePaths(text), [text]);
  // Artifacts that open in Quick Look, in listed order, for ←/→ navigation.
  const viewable: PreviewFile[] = useMemo(
    () =>
      paths
        .filter((p) => previewKind(p.split("/").pop() || p) !== null)
        .map((p) => ({ path: p, name: p.split("/").pop() || p, chatId })),
    [paths, chatId],
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
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{t("artifacts", { count: paths.length })}</span>
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
      <div className="flex flex-wrap gap-3">
        {paths.map((p) => (
          <SandboxFileTile key={p} file={{ path: p, name: p.split("/").pop() || p, chatId }} viewable={viewable} verify live={live} />
        ))}
      </div>
    </div>
  );
}


/** The model's reasoning — a node on the same rail as the tool actions, marked
 *  with a lightbulb. The thought text shows inline: the surrounding ActivityGroup
 *  owns the collapse, so once a run is expanded the user reads the thinking
 *  directly (no second click). The badge tops-aligns to the first line so it
 *  reads as a paragraph annotation rather than a centred single-line row. */
function ReasoningRow({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  // Strip leaked chain-of-thought wrapper tags and the extra leading break some
  // models open a thought with — recomputed only when the streamed text grows.
  const clean = useMemo(() => cleanReasoning(text), [text]);
  return (
    <div className="animate-step-in relative py-1 pl-10 text-muted-foreground">
      <span className="absolute left-0 top-1 grid h-[27px] w-[27px] place-items-center rounded-full border border-border bg-card text-muted-foreground">
        <Lightbulb className={`animate-step-badge-in h-3.5 w-3.5 ${isStreaming ? "animate-pulse" : ""}`} />
      </span>
      <p className="whitespace-pre-wrap text-sm italic leading-relaxed">{clean}</p>
    </div>
  );
}

/** The round node on the rail: a category icon, a branded chip for connected
 *  apps (MCP), or a live spinner while the step runs. Centred on the rail line. */
function StepBadge({ d, state }: { d: StepDescriptor; state: "running" | "error" | "done" }) {
  const base =
    "absolute left-0 top-1/2 -translate-y-1/2 grid h-[27px] w-[27px] place-items-center overflow-hidden rounded-full border bg-card";
  if (state === "running") {
    return (
      <span className={`${base} border-border text-foreground`}>
        <span className="spinner-ring h-3.5 w-3.5 animate-spin rounded-full" />
      </span>
    );
  }
  // Connected app with a known brand — a coloured letter chip, not a wrench.
  if (d.category === "mcp" && d.brand?.color) {
    return (
      <span className={`${base} ${state === "error" ? "border-destructive/45" : "border-border"}`}>
        <span
          className="animate-step-badge-in grid h-full w-full place-items-center text-[11px] font-bold text-white"
          style={{ backgroundColor: d.brand.color }}
        >
          {d.brand.letter}
        </span>
      </span>
    );
  }
  const Icon = d.Icon;
  const tone = state === "error" ? "border-destructive/45 text-destructive" : "border-border text-muted-foreground";
  return (
    <span className={`${base} ${tone}`}>
      <Icon className="animate-step-badge-in h-3.5 w-3.5" />
    </span>
  );
}

/** One step on the rail: badge + intent label + optional dim detail, with the
 *  output/error tucked into a click-to-expand block beneath it. */
function StepRow({ part }: { part: ToolPart }) {
  const tSteps = useTranslations("steps");
  const t = useTranslations("chat.tool");
  const rawName = getToolName(part);
  const d = describeStep(tSteps, rawName, part.input);
  const state: "running" | "error" | "done" =
    part.state === "output-error" ? "error" : part.state.startsWith("output-") ? "done" : "running";
  const isRunning = state === "running";
  const isError = state === "error";
  const expandable = !isRunning && (isError ? !!part.errorText : !!formatValue(part.output));

  const row = (
    <div
      className={`animate-step-in relative flex min-h-[34px] items-center gap-3 py-1 pl-10 ${
        isError ? "text-destructive" : isRunning ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <StepBadge d={d} state={state} />
      <span className="text-sm">
        {isRunning ? d.activeLabel : d.label}
        {isError ? ` · ${t("failed")}` : ""}
      </span>
      {d.detail && (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">{d.detail}</span>
      )}
      {expandable && (
        <ChevronRight className="chevron ml-auto h-3.5 w-3.5 shrink-0 opacity-35 transition-transform" />
      )}
    </div>
  );

  if (!expandable) return row;

  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="block w-full text-left transition-colors hover:text-foreground [&[data-state=open]_.chevron]:rotate-90">
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 ml-10 rounded-lg bg-muted/40 p-2.5">
          <ToolDetails toolName={rawName} output={part.output} errorText={part.errorText} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A single unit of work on the rail — either the model thinking or a tool call. */
type ActivityItem = { kind: "reasoning"; text: string } | { kind: "tool"; part: ToolPart };

/** The terminal "Done ✓" node that caps a finished run, so the rail reads as a
 *  completed timeline rather than trailing off after the last step. Only shown
 *  once the run has stopped streaming. */
function DoneRow() {
  const t = useTranslations("chat.tool");
  return (
    <div className="animate-step-in relative flex min-h-[34px] items-center gap-3 py-1 pl-10 text-muted-foreground">
      <span className="absolute left-0 top-1/2 grid h-[27px] w-[27px] -translate-y-1/2 place-items-center rounded-full border border-border bg-card text-muted-foreground">
        <Check className="animate-step-badge-in h-3.5 w-3.5" />
      </span>
      <span className="text-sm">{t("done")}</span>
    </div>
  );
}

/** Renders an interleaved run of reasoning + tool calls as one vertical step
 *  rail — a single thin line connecting each node, so thinking and actions read
 *  as one quiet "here's what I did" timeline rather than two different styles.
 *  A finished run is capped with a terminal "Done ✓" node. */
function ActivityRail({ items, isStreaming }: { items: ActivityItem[]; isStreaming?: boolean }) {
  const lastIdx = items.length - 1;
  const rows = items.map((it, i) => {
    const streaming = isStreaming && i === lastIdx;
    return it.kind === "reasoning"
      ? <ReasoningRow key={`r${i}`} text={it.text} isStreaming={streaming} />
      : <StepRow key={it.part.toolCallId} part={it.part} />;
  });
  if (!isStreaming) rows.push(<DoneRow key="done" />);

  // A lone node needs no connecting line.
  if (rows.length === 1) return <>{rows}</>;

  return (
    <div className="relative my-0.5">
      {/* the connecting line, centred under the 27px badges */}
      <div className="pointer-events-none absolute bottom-4 left-[13px] top-4 w-px bg-border" aria-hidden="true" />
      {rows}
    </div>
  );
}

/** The one-line summary shown on a collapsed activity run — the "last action",
 *  Claude-style. While the run is live it names what's happening *now* (the last
 *  item, present tense); once finished it names the last concrete tool step
 *  ("Read SKILL.md") so the header carries information, falling back to a plain
 *  "Reasoning" tag for a pure-thinking run. */

/** Wraps a run of reasoning + tool calls in a single quiet spoiler whose header
 *  reads, Grok-style, how long the run took — "Reasoned for 58s ›". While it
 *  streams the timer ticks live from first paint; once it stops we freeze the
 *  measured value. Reloaded history (never streamed in this session) falls back
 *  to the stored turn duration so it still shows a number. Auto-opens while live
 *  and auto-collapses when the answer begins, with a manual click taking over. */
function ActivityGroup({ items, isStreaming, fallbackMs }: { items: ActivityItem[]; isStreaming?: boolean; fallbackMs?: number }) {
  const t = useTranslations("chat.message");
  const streaming = !!isStreaming;
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpen] = useState(streaming);
  const [prevStreaming, setPrevStreaming] = useState(streaming);
  if (!userToggled && prevStreaming !== streaming) {
    setPrevStreaming(streaming);
    setOpen(streaming);
  }

  // Live stopwatch: start on first streaming paint, tick each second, freeze the
  // elapsed value the moment streaming stops (which is when the answer begins —
  // so this measures reasoning + tools, not the whole turn).
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (streaming) {
      if (startRef.current == null) startRef.current = Date.now();
      setElapsed(Date.now() - startRef.current);
      const id = setInterval(() => {
        if (startRef.current != null) setElapsed(Date.now() - startRef.current);
      }, 1000);
      return () => clearInterval(id);
    }
    if (startRef.current != null) setElapsed(Date.now() - startRef.current);
  }, [streaming]);

  const ms = elapsed ?? fallbackMs ?? null;
  const hasReasoning = items.some((it) => it.kind === "reasoning");
  const label =
    ms != null
      ? t(hasReasoning ? "reasonedFor" : "workedFor", { duration: formatShortDuration(ms) })
      : streaming
        ? t("thinking")
        : t(hasReasoning ? "reasoning" : "activity");

  return (
    <Collapsible open={open} onOpenChange={(v) => { setUserToggled(true); setOpen(v); }}>
      <CollapsibleTrigger className="group/act inline-flex max-w-full items-center gap-1.5 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]_.chevron]:rotate-90">
        <span className={`min-w-0 truncate ${streaming ? "animate-pulse" : ""}`}>{label}</span>
        <ChevronRight className="chevron h-3.5 w-3.5 shrink-0 opacity-40 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5">
          <ActivityRail items={items} isStreaming={isStreaming} />
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

/** Calm heads-up shown when the model couldn't natively take an attached media
 *  type (e.g. an audio note sent to a text-only model). Amber, not red — it's a
 *  limitation, not a failure. The embedded model picker IS the one-tap fix:
 *  switch to a capable model, then regenerate. */
function CapabilityNotice({
  modalities, model, onModelChange,
}: {
  modalities: string[];
  model?: string;
  onModelChange?: (model: string) => void;
}) {
  const t = useTranslations("chat.notice");
  const list = modalities.map((m) => t(`modality.${m}`)).join(", ");
  return (
    <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5">
      <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1">
          <span>{t("blindModalities", { modalities: list })}</span>
          {onModelChange && model !== undefined && (
            <div className="mt-1.5 inline-flex rounded-full border border-amber-500/30 bg-background/50 px-1">
              <ModelPicker variant="pill" value={model} onChange={onModelChange} />
            </div>
          )}
        </div>
      </div>
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

/** "‹ i/N ›" version switcher — shown only when a message has alternative
 *  siblings (from an edit or a regenerate). Flips the visible branch. */
function BranchSwitcher({
  index, count, messageId, onSwitch,
}: {
  index: number;
  count: number;
  messageId: string;
  onSwitch: (messageId: string, direction: "prev" | "next") => void;
}) {
  const t = useTranslations("chat.message");
  if (count <= 1) return null;
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground" aria-label={t("versions", { count })}>
      <button
        type="button"
        onClick={() => onSwitch(messageId, "prev")}
        disabled={index <= 0}
        title={t("prevVersion")}
        aria-label={t("prevVersion")}
        className="rounded-md p-0.5 transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums">{index + 1}/{count}</span>
      <button
        type="button"
        onClick={() => onSwitch(messageId, "next")}
        disabled={index >= count - 1}
        title={t("nextVersion")}
        aria-label={t("nextVersion")}
        className="rounded-md p-0.5 transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Fork from this message into a new chat — explore an alternative path without
 *  disturbing the current conversation. */
function ForkButton({ messageId, onFork }: { messageId: string; onFork: (messageId: string) => void }) {
  const t = useTranslations("chat.message");
  return (
    <button
      type="button"
      onClick={() => onFork(messageId)}
      title={t("fork")}
      aria-label={t("fork")}
      className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      <GitBranch className="h-3.5 w-3.5" />
    </button>
  );
}

function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  // scrollHeight covers content + padding but not borders; with border-box that
  // leaves the box a couple px short (and the last line clipped). Add the border.
  const borders = ta.offsetHeight - ta.clientHeight;
  ta.style.height = `${ta.scrollHeight + borders}px`;
}

/** A user message bubble. With `onEdit` it gains an inline editor: click the
 *  pencil to rewrite the message and re-run the conversation from that point
 *  (⌘/Ctrl+Enter saves, Esc cancels) — the familiar ChatGPT gesture. */
/**
 * The files a user attached to a message, rendered with the same FileCard/FileRow
 * the AI uses for delivered files — visible name, real thumbnail, Quick Look on
 * click. Bytes are fetched lazily from the sandbox, never re-sent to the model.
 */
function MessageAttachments({ chatId, files }: { chatId: string; files: { name: string; type: string }[] }) {
  // Same square tiles the AI uses for delivered files — real thumbnail, visible
  // name, Quick Look on click. Files live at /workspace root in the sandbox.
  const viewable: PreviewFile[] = files
    .filter((f) => previewKind(f.name) !== null)
    .map((f) => ({ path: f.name, name: f.name, chatId }));
  return (
    <div className="mb-1.5 flex max-w-full flex-wrap justify-end gap-3">
      {files.map((f) => (
        <SandboxFileTile key={f.name} file={{ path: f.name, name: f.name, chatId }} viewable={viewable} />
      ))}
    </div>
  );
}

function UserBubble({
  text, messageId, timestamp, isTelegram, siblingIndex, siblingCount, chatId, attachedFiles, onEdit, onSwitchBranch, onFork,
}: {
  text: string;
  messageId: string;
  timestamp: string;
  isTelegram: boolean;
  siblingIndex: number;
  siblingCount: number;
  chatId?: string;
  attachedFiles?: { name: string; type: string }[];
  onEdit?: (messageId: string, newText: string) => void;
  onSwitchBranch?: (messageId: string, direction: "prev" | "next") => void;
  onFork?: (messageId: string) => void;
}) {
  const tCommon = useTranslations("common");
  const tMsg = useTranslations("chat.message");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // The edit/fork actions sit hidden until hover on the web; on touch there's no
  // hover, so a long-press reveals them. A following tap or scroll hides them.
  const [revealed, setRevealed] = useState(false);
  const longPress = useLongPress(() => { setRevealed(true); haptic("tap"); });
  useEffect(() => {
    if (!revealed) return;
    const close = () => setRevealed(false);
    // Defer arming so the press that opened it doesn't immediately close it.
    const id = setTimeout(() => {
      document.addEventListener("pointerdown", close, { once: true, capture: true });
      window.addEventListener("scroll", close, { once: true, capture: true });
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [revealed]);

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow(ta);
  }, [editing]);

  const save = () => {
    const v = draft.trim();
    if (v && v !== text) onEdit?.(messageId, v);
    setEditing(false);
  };
  const cancel = () => { setDraft(text); setEditing(false); };

  if (editing) {
    return (
      <div className="group/msg flex animate-blur-rise justify-end px-4 md:px-6 py-4">
        <div className="w-full max-w-[85%]">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); autoGrow(e.target); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
              if (e.key === "Escape") { e.preventDefault(); cancel(); }
            }}
            rows={1}
            className="w-full resize-none overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40 md:text-[15px]"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel}>{tCommon("cancel")}</Button>
            <Button size="sm" onClick={save}>{tCommon("save")}</Button>
          </div>
        </div>
      </div>
    );
  }

  const hasFiles = !!chatId && !!attachedFiles && attachedFiles.length > 0;

  return (
    <div
      className="group/msg flex animate-blur-rise justify-end px-4 md:px-6 py-4"
      data-revealed={revealed || undefined}
      {...longPress}
    >
      <div className="flex max-w-[75%] flex-col items-end lg:max-w-[65%] [-webkit-touch-callout:none]">
        {hasFiles && <MessageAttachments chatId={chatId!} files={attachedFiles!} />}
        {/* When the turn is files-only, the thumbnails are the content — skip the
            empty "…" bubble. */}
        {(text || !hasFiles) && (
          <div className="inline-block whitespace-pre-wrap break-words rounded-2xl border border-border bg-card text-card-foreground px-5 py-3 text-[15px] shadow-sm">
            {text || "…"}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1">
          {onSwitchBranch && (
            <BranchSwitcher index={siblingIndex} count={siblingCount} messageId={messageId} onSwitch={onSwitchBranch} />
          )}
          {onEdit && text && (
            <button
              type="button"
              onClick={() => { setDraft(text); setEditing(true); }}
              title={tMsg("edit")}
              aria-label={tMsg("edit")}
              className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground opacity-0 transition hover:bg-accent/50 hover:text-foreground group-hover/msg:opacity-100 group-data-[revealed]/msg:opacity-100"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {onFork && (
            <span className="opacity-0 transition group-hover/msg:opacity-100 group-data-[revealed]/msg:opacity-100">
              <ForkButton messageId={messageId} onFork={onFork} />
            </span>
          )}
          <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />
        </div>
      </div>
    </div>
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

/** Token/timing/cost numbers an assistant turn carries. All optional — the (i)
 *  affordance only appears when at least one of these is present (so messages
 *  predating this feature stay clean). */
type TechDetails = {
  durationMs?: number;
  model?: string;
  usage?: { input: number; output: number; cached: number };
  costUsd?: number;
};

/** Render the AI work time as "12.3s" under a minute, "1m 3s" beyond it. */
function formatDuration(ms: number, t: TimeTranslator): string {
  const sec = ms / 1000;
  if (sec < 60) return t("durationSec", { s: sec.toFixed(1) });
  return t("durationMin", { m: Math.floor(sec / 60), s: Math.round(sec % 60) });
}

/** One label/value line in the details popover; value is tabular for alignment. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

/** The (i) affordance beside an assistant reply's timestamp. Click opens a small
 *  popover with model, tokens, work time and exact send time. Cost in $ is shown
 *  to admins only — the deployment runs on a shared admin key, so per-message
 *  spend is sensitive for ordinary staff. */
function MessageDetails({
  details, createdAt, isAdmin, steps,
}: {
  details: TechDetails;
  createdAt: string;
  isAdmin?: boolean;
  /** Tool calls in this turn — a quick read of how much work the AI did. */
  steps?: number;
}) {
  const t = useTranslations("chat.details");
  const locale = useLocale();
  const { durationMs, model, usage, costUsd } = details;
  // Nothing meaningful to show (e.g. a failed/cancelled turn, or a message from
  // before this feature) — don't render the icon at all.
  if (durationMs == null && model == null && usage == null) return null;

  const nf = new Intl.NumberFormat(locale);
  const exactTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium", timeStyle: "short",
  }).format(new Date(createdAt));
  // Output throughput — derived, only meaningful with both numbers and a turn
  // long enough that the rate isn't noise.
  const tokensPerSec =
    usage && durationMs && durationMs >= 500 && usage.output > 0
      ? Math.round(usage.output / (durationMs / 1000))
      : null;

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-[popup-open]:bg-accent/50 data-[popup-open]:text-foreground"
        aria-label={t("show")}
        title={t("show")}
      >
        <Info className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent className="min-w-56 space-y-1.5 text-xs" side="top" align="start">
        {model && <DetailRow label={t("model")} value={model} />}
        {steps != null && steps > 0 && <DetailRow label={t("steps")} value={nf.format(steps)} />}
        {usage && <DetailRow label={t("inputTokens")} value={nf.format(usage.input)} />}
        {usage && <DetailRow label={t("outputTokens")} value={nf.format(usage.output)} />}
        {usage && usage.cached > 0 && <DetailRow label={t("cache")} value={nf.format(usage.cached)} />}
        {durationMs != null && <DetailRow label={t("duration")} value={formatDuration(durationMs, t)} />}
        {tokensPerSec != null && <DetailRow label={t("speed")} value={t("speedValue", { n: nf.format(tokensPerSec) })} />}
        {isAdmin && costUsd != null && (
          <DetailRow
            label={t("cost")}
            value={new Intl.NumberFormat(locale, {
              style: "currency", currency: "USD", maximumFractionDigits: 4,
            }).format(costUsd)}
          />
        )}
        <DetailRow label={t("sentAt")} value={exactTime} />
      </PopoverContent>
    </Popover>
  );
}

// --- Main component ---

interface ChatMessageProps {
  message: UIMessage;
  isStreaming?: boolean;
  chatId?: string;
  isAdmin?: boolean;
  /** Provided only on the latest assistant reply — re-runs the same prompt. */
  onRegenerate?: () => void;
  /** Provided on user messages — replaces the text and re-runs from there. */
  onEdit?: (messageId: string, newText: string) => void;
  /** Flip between alternative versions of this message (edits/regenerations). */
  onSwitchBranch?: (messageId: string, direction: "prev" | "next") => void;
  /** Fork the conversation from this message into a new chat. */
  onFork?: (messageId: string) => void;
  /** The chat's active model + setter — lets the capability notice offer a
   *  one-tap switch to a model that can actually see/hear the attachment. */
  model?: string;
  onModelChange?: (model: string) => void;
}

function ChatMessageImpl({ message, isStreaming, chatId, isAdmin, onRegenerate, onEdit, onSwitchBranch, onFork, model, onModelChange }: ChatMessageProps) {
  const locale = useLocale();
  const t = useTranslations("chat.message");
  const tTime = useTranslations("chat.time");
  const tErr = useTranslations("errors.llm");
  const isUser = message.role === "user";
  const metadata = message.metadata as
    | { createdAt?: string | null; platform?: string | null; taskStatus?: string | null; error?: string | null; errorDetail?: string | null; errorCategory?: string | null; siblingIndex?: number; siblingCount?: number; attachedFiles?: { name: string; type: string }[]; durationMs?: number; reasoningMs?: number; model?: string; usage?: { input: number; output: number; cached: number }; costUsd?: number; notice?: { kind: string; modalities: string[] } }
    | undefined;

  const [createdAt] = useState(() => metadata?.createdAt ?? new Date().toISOString());
  const timestamp = formatRelativeTime(createdAt, locale, tTime);
  const isTelegram = metadata?.platform === "telegram";
  const siblingIndex = metadata?.siblingIndex ?? 0;
  const siblingCount = metadata?.siblingCount ?? 1;

  if (isUser) {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    return (
      <UserBubble
        text={text}
        messageId={message.id}
        timestamp={timestamp}
        isTelegram={isTelegram}
        siblingIndex={siblingIndex}
        siblingCount={siblingCount}
        chatId={chatId}
        attachedFiles={metadata?.attachedFiles}
        onEdit={onEdit}
        onSwitchBranch={onSwitchBranch}
        onFork={onFork}
      />
    );
  }

  // Assistant — group consecutive parts: answer text stays on its own, while
  // runs of reasoning + tool calls merge into one "activity" rail so thinking
  // and actions read as a single timeline rather than two competing styles.
  const parts = message.parts;
  type Group =
    | { kind: "text"; text: string }
    | { kind: "activity"; items: ActivityItem[] };
  const groups: Group[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = (part as { text: string }).text;
      if (text) groups.push({ kind: "text", text });
    } else if (part.type === "reasoning") {
      const text = (part as { text: string }).text;
      if (!text) continue;
      const last = groups[groups.length - 1];
      if (last?.kind === "activity") {
        const lastItem = last.items[last.items.length - 1];
        if (lastItem?.kind === "reasoning") lastItem.text += text;
        else last.items.push({ kind: "reasoning", text });
      } else {
        groups.push({ kind: "activity", items: [{ kind: "reasoning", text }] });
      }
    } else if (isToolPart(part)) {
      const last = groups[groups.length - 1];
      if (last?.kind === "activity") last.items.push({ kind: "tool", part: part as ToolPart });
      else groups.push({ kind: "activity", items: [{ kind: "tool", part: part as ToolPart }] });
    }
  }
  const lastTextIdx = groups.reduce((acc, g, i) => g.kind === "text" ? i : acc, -1);
  const lastIdx = groups.length - 1;

  // An assistant turn that's still warming up (no parts yet) renders nothing —
  // the single "working…" indicator in the panel owns that state. Rendering an
  // empty padded bubble here would just shove the indicator down a notch the
  // moment the row is created, then again when the first step replaces it.
  if (!isUser && groups.length === 0 && isStreaming && metadata?.taskStatus !== "failed") {
    return null;
  }

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
            // No wrapper blur-rise here — the spoiler header animates itself in,
            // and on expand each rail row surfaces with .animate-step-in.
            return (
              <div key={gi} className={gi > 0 ? "mt-1.5" : ""}>
                <ActivityGroup items={g.items} isStreaming={isStreaming && gi === lastIdx} fallbackMs={metadata?.reasoningMs} />
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
        {metadata?.notice?.kind === "blind-modalities" && metadata.notice.modalities.length > 0 && (
          <CapabilityNotice
            modalities={metadata.notice.modalities}
            model={model}
            onModelChange={onModelChange}
          />
        )}
        {!isStreaming && (() => {
          const copyText = groups.filter((g) => g.kind === "text").map((g) => g.text).join("\n\n").trim();
          return (
            <div className="mt-1 flex items-center gap-1">
              {onSwitchBranch && (
                <BranchSwitcher index={siblingIndex} count={siblingCount} messageId={message.id} onSwitch={onSwitchBranch} />
              )}
              {copyText && <CopyButton text={copyText} />}
              {onRegenerate && (
                <button
                  type="button"
                  onClick={onRegenerate}
                  title={t("regenerate")}
                  aria-label={t("regenerate")}
                  className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              {onFork && <ForkButton messageId={message.id} onFork={onFork} />}
              <MessageDetails
                details={{ durationMs: metadata?.durationMs, model: metadata?.model, usage: metadata?.usage, costUsd: metadata?.costUsd }}
                createdAt={createdAt}
                isAdmin={isAdmin}
                steps={parts.filter(isToolPart).length}
              />
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
