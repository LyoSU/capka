import { type UIMessage } from "ai";
import {
  Send, Download, Copy, Check, RotateCcw, Pencil,
  ChevronLeft, ChevronRight, GitBranch, X, Lightbulb, Info,
  MoreHorizontal, ArrowRight, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Hint } from "@/components/ui/tooltip";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu";
import { Markdown } from "@/components/chat/markdown";
import { haptic } from "@/lib/haptics";
import { useLongPress } from "@/hooks/use-long-press";
import { Fragment, useState, useMemo, useEffect, useLayoutEffect, useRef, memo } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { previewKind } from "@/lib/file-kinds";
import { extractWorkspacePaths, splitTouchedByMention } from "@/lib/chat/artifacts";
import { cleanReasoning } from "@/lib/chat/reasoning";
import { useDisclosureAnchor } from "@/components/chat/use-chat-scroll";
import { formatShortDuration } from "@/lib/chat/duration";
import { LLM_ERROR_CATEGORIES, type LLMErrorCategory } from "@/lib/errors/friendly";
import { SandboxFileTile, FileThumb, usePreview, type PreviewFile } from "./file-preview";
import { MessageEditor } from "./message-editor";
import type { FileRef } from "@/lib/constants";
import { describeStep, describeInvocation, type StepDescriptor, type StepInvocation, type StepCategory } from "./steps";
import {
  recordsFromValue, recordsFromText, looksLikeMarkdown, readsAsTable,
  fieldsFromValue, imagesFromValue, resourcesFromValue, type TextRecord,
} from "@/lib/chat/record-list";
import { isBareUrl, type StepField } from "@/lib/chat/steps";
import { sourcesFromOutput, type NumberedSource } from "@/lib/mcp/search-normalize";
import { hostOf, CitedSourcesFooter } from "./sources";
import { citedSources } from "@/lib/chat/citations";
import { AskCard } from "./ask-card";
import { ManageCard, ApprovalCard, isManageCard, manageStepLabel } from "./manage-cards";
import { copyToClipboard } from "@/lib/clipboard";

/** useLayoutEffect warns during SSR; these are client components still rendered on
 *  the server, so fall back there. Stable per render. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Is the reader actively using what's inside this panel? Focus inside it, or a
 *  text selection within it, both mean the app's tidying-up instinct does not get
 *  to close it — nothing feels worse than an interface folding away the thing you
 *  were reading, and "the turn finished" is not a good enough reason. */
function isReaderEngaged(root: HTMLElement): boolean {
  const active = document.activeElement;
  if (active && active !== document.body && root.contains(active)) return true;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  // Both ends, not the common ancestor: a selection that starts inside this panel
  // and runs past its end has an ancestor ABOVE us, so asking about the ancestor
  // would report "not engaged" and collapse the very text being selected.
  return (
    (!!sel.anchorNode && root.contains(sel.anchorNode)) ||
    (!!sel.focusNode && root.contains(sel.focusNode))
  );
}

// --- Helpers ---

// The server stores the failure category in message metadata; the user-facing
// text is rendered here (localized) instead of the English string baked in at
// runtime. Read off the shared list rather than re-typed, so a new category
// can't quietly lose its localized copy — the catalog parity test guards the
// other half.
const LOCALIZED_ERROR_CATEGORIES = new Set<string>(LLM_ERROR_CATEGORIES);

/** Failures that left work standing: the turn stopped part-way, so the move is to
 *  carry on, not to regenerate and rewrite what is already on screen. Each is the
 *  partial half of a two-way split the runner makes from the turn's saved parts. */
const PARTIAL_ERROR_CATEGORIES = new Set<string>([
  "provider_unresponsive_partial",
  "response_truncated",
  "timed_out_partial",
  "interrupted_partial",
] satisfies LLMErrorCategory[]);

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

  // Capka sandbox tool shapes — show the human-meaningful field, never the
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
  approval?: { id: string; approved?: boolean; reason?: string };
  askForm?: import("@/lib/ask/types").AskForm;
  askValue?: import("@/lib/ask/types").AskAnswer;
};

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type === "dynamic-tool" || (part.type.startsWith("tool-") && part.type !== "tool");
}

/** A tool call the SDK suspended for native approval — `manage`, or any
 *  connector/skill call under a governance "ask". While the user's decision is
 *  the required action (or the call was declined), it renders as the prominent
 *  approval card, never the quiet activity rail. `manage` keeps the card through
 *  its resolved states too (the applied change IS the outcome); a gated ordinary
 *  tool returns to the timeline once it has run, so its result renders with the
 *  full shape ladder instead of being trapped in a consent card. */
function isApprovalPart(part: ToolPart): boolean {
  if (getToolName(part) === "manage") {
    return part.state === "approval-requested" || part.state === "approval-responded" || !!part.approval;
  }
  return part.state === "approval-requested" || part.state === "approval-responded";
}

/** An `ask` tool call the runner suspended for a human answer — it (and its
 *  answered state) always renders as the prominent question card. */
function isAskPart(part: ToolPart): boolean {
  return getToolName(part) === "ask" && !!part.askForm;
}

function getToolName(part: ToolPart): string {
  if (part.toolName) return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice(5);
  return "unknown";
}

// --- Tool detail renderer ---

/** The small ref view_file persists (bytes never touch the DB) — detected by
 *  shape so we can render the rendered pages as thumbnails instead of its JSON.
 *  Shape-checked inline (not imported from view-file.ts, which is server-only). */
type MediaRefLike = { kind: "media"; pages: { page: number; path: string }[] };
function asMediaRef(v: unknown): MediaRefLike | null {
  const o = v as MediaRefLike | null;
  return o && typeof o === "object" && o.kind === "media" && Array.isArray(o.pages) ? o : null;
}

/** How much of a result is shown before the reader has to ask for the rest.
 *  The value matters less than the fact that overrunning it is now STATED — the
 *  old code sliced at this size and appended an ellipsis, which is indistinguishable
 *  from an output that genuinely ended there. A result that misreports its own
 *  completeness is worse than one that is merely long. Tool output is already
 *  clamped to ~30k server-side (see clampOutput), so "show all" cannot be huge. */
const OUTPUT_LIMIT = 2000;

/** The same disclosure applied to the INVOCATION, and it is load-bearing for a
 *  different reason than the result's.
 *
 *  Nothing clamps a tool's INPUT anywhere — `clampOutput` bounds what comes back,
 *  not what was sent — and until this panel existed that was harmless, because
 *  `part.input` only ever reached `describeStep`, which clips it to 48 characters
 *  for the row's chip. Rendering it in full put an unbounded string through the
 *  markdown renderer's syntax highlighter, so a `write_file` carrying a large body
 *  would highlight the whole thing the moment the step was expanded. Higher than
 *  OUTPUT_LIMIT because code is the thing you actually came here to read; the rest
 *  is one click away, and that click is the user choosing to pay for it. */
const INVOCATION_LIMIT = 4000;

/** Everything that came BACK from a call: output, or the error that replaced it.
 *
 *  Takes the step's `category` rather than its tool name. The previous version
 *  sniffed the name for substrings — `lower.includes("read")`, `.includes("exec")` —
 *  which quietly mis-rendered any tool whose name happened to contain one of those
 *  words (an MCP `read_spreadsheet` got source-code treatment). `describeStep`
 *  already decides what kind of thing a tool is, under test; this uses that answer
 *  instead of guessing a second time from a different signal. */
function ToolDetails({ category, output, errorText, chatId }: { category: StepCategory; output?: unknown; errorText?: string; chatId?: string }) {
  const t = useTranslations("chat.tool");
  const [showAll, setShowAll] = useState(false);

  const isError = !!errorText;
  const full = errorText ?? formatValue(output);
  // Machine-shaped output keeps monospace (alignment carries meaning in a file
  // listing or a traceback); prose-shaped output — a web result, an MCP reply —
  // reads better in the body face at a readable size.
  const mono = category === "exec" || category === "file";
  // A result that arrived as TEXT but is really one JSON value — a connector
  // that stringifies its payload into a text block — re-enters the same shape
  // ladder the typed path uses. Parse, don't sniff: JSON.parse is the detector,
  // and a scalar or a parse failure leaves the text exactly as it was.
  const parsed = useMemo(() => {
    if (isError) return null;
    const head = full.trimStart();
    if (!head.startsWith("{") && !head.startsWith("[")) return null;
    try {
      const v: unknown = JSON.parse(full);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }, [isError, full]);
  // Search results the adapter normalized (mcp/search-normalize.ts) — rendered
  // as the numbered source list the reply's [N] chips point into, ahead of the
  // generic record ladder so the numbers the model cited stay visible.
  const searchSources = useMemo(() => (isError ? null : sourcesFromOutput(output)), [isError, output]);
  // A result that is a LIST — typed records per the MCP spec, or `Key: value`
  // text blocks — renders as one. Never for errors (a traceback is a text) and
  // never for exec/file output, where the bytes themselves are the artifact.
  const records = useMemo(
    () => (isError || mono || searchSources ? null : recordsFromValue(output) ?? (parsed ? recordsFromValue(parsed) : null) ?? recordsFromText(full)),
    [isError, mono, searchSources, output, parsed, full],
  );
  // The envelope's other block types, per the MCP spec: images the tool drew,
  // resources it pointed at. They accompany whatever textual shape renders
  // below — a result can legitimately carry both.
  const images = useMemo(() => (isError ? null : imagesFromValue(output)), [isError, output]);
  const resources = useMemo(() => (isError ? null : resourcesFromValue(output)), [isError, output]);
  // A single typed object earns the same grid the params view uses — but only
  // when the text pipeline fell through to raw JSON, so a tool that answered
  // in prose never has that prose displaced by field rows.
  const fields = useMemo(
    () => (isError || mono || records || !parsed ? null : fieldsFromValue(output) ?? fieldsFromValue(parsed)),
    [isError, mono, records, parsed, output],
  );
  // Capka's own sandbox commands return { output, exitCode } — a first-party
  // shape, trusted the same way asMediaRef is. Without this, a command that
  // FAILED renders indistinguishably from one that succeeded, because the tool
  // call itself completed fine and errorText stays empty.
  const exitCode = (() => {
    const o = output as Record<string, unknown> | null;
    return !isError && o && typeof o === "object" && typeof o.output === "string" && typeof o.exitCode === "number" && o.exitCode !== 0
      ? o.exitCode
      : null;
  })();

  const extras = (images || resources) && (
    <>
      {images && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((im, i) => (
            // The same fixed box the view_file thumbnails reserve, for the same
            // reason: an unsized image decodes late and shoves the page.
            // eslint-disable-next-line @next/next/no-img-element -- inline data URI carried by the tool result, not a static asset
            <img key={i} src={im.src} alt="" loading="lazy" className="h-40 w-32 rounded-md border border-border bg-muted/40 object-contain" />
          ))}
        </div>
      )}
      {resources && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {resources.map((r, i) => (
            <li key={i} className="min-w-0">
              {isBareUrl(r.uri) ? (
                <a
                  href={r.uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={r.description ?? r.uri}
                  className="flex max-w-full items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-link transition-colors hover:border-primary/40"
                >
                  <span className="truncate">{r.name}</span>
                </a>
              ) : (
                // A non-web URI (file://, a custom scheme) is an identifier the
                // reader can quote, not a place a browser can go — no dead link.
                <span title={r.description ?? r.uri} className="flex max-w-full items-center rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  <span className="truncate">{r.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );

  // view_file result: show the rendered page(s) as thumbnails, served inline from
  // the workspace (no base64 in the DB or the payload). A page rotated out of the
  // sandbox 404s — hide it rather than showing a broken image.
  const media = asMediaRef(output);
  if (!errorText && media && chatId && media.pages.length) {
    return (
      <div className="flex flex-wrap gap-2">
        {media.pages.slice(0, 4).map((pg) => (
          // A box fixed in BOTH axes, with the page fitted inside it.
          //
          // An unsized image is zero-by-zero until it decodes, so a rendered page
          // landing shoved everything below it down by its full height — at a moment
          // nothing announces and React never re-renders for. Pinning only the height
          // is not enough either: the decoded WIDTH still changes, and in a wrapping
          // row that can change how many tiles fit per line and move the block by a
          // whole row. The workspace tiles elsewhere already reserve a fixed box for
          // exactly this reason; this now matches them. `object-contain` means the box
          // is a frame, not a crop, so no aspect ratio has to be guessed at.
          // eslint-disable-next-line @next/next/no-img-element -- authed same-origin workspace stream, not a static asset
          <img
            key={pg.path}
            src={`/api/sandbox/files/download?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(pg.path)}&inline=1`}
            alt=""
            loading="lazy"
            className="h-40 w-32 rounded-md border border-border bg-muted/40 object-contain"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ))}
      </div>
    );
  }

  // One code path for output and error alike: an error IS the result of the call,
  // and the old bare <p> gave a multi-line sandbox stack trace no monospace, no
  // wrapping, no scroll and no way to copy it — the one result a user is most
  // likely to need to send to somebody else.
  if (!full) {
    return (
      <section>
        <BlockLabel>{t("result")}</BlockLabel>
        {/* An image- or resource-only result is a real result — "done" is the
            wording for a call that returned NOTHING to show, and only that. */}
        {extras || <p className="text-xs text-muted-foreground">{t("done")}</p>}
      </section>
    );
  }

  if (searchSources) {
    return (
      <section>
        <BlockLabel action={<CopyButton text={full} />}>{t("result")}</BlockLabel>
        {extras}
        <SourceList sources={searchSources} />
      </section>
    );
  }

  if (records) {
    return (
      <section>
        {/* The copy button still copies the TEXT the tool returned, not the
            rendering — what came back is the artifact, the list is a view. */}
        <BlockLabel action={<CopyButton text={full} />}>{t("result")}</BlockLabel>
        {extras}
        <RecordList records={records} />
      </section>
    );
  }

  if (fields) {
    return (
      <section>
        <BlockLabel action={<CopyButton text={full} />}>{t("result")}</BlockLabel>
        {extras}
        <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
          <FieldsGrid fields={fields} />
        </div>
      </section>
    );
  }

  const over = full.length > OUTPUT_LIMIT;
  const body = over && !showAll ? full.slice(0, OUTPUT_LIMIT) : full;

  // Markdown-shaped output (a scraped page, a connector's formatted reply) goes
  // through the SAME renderer the answers use — links click, lists indent —
  // instead of showing its own syntax as noise. `reasoning-prose` flattens the
  // heading scale: a scraped page's <h1> has no business shouting inside a step
  // panel. While clamped, the prefix renders as incomplete markdown so a cut
  // link or list does not mangle the tail.
  if (!isError && !mono && looksLikeMarkdown(full)) {
    return (
      <section>
        <BlockLabel action={<CopyButton text={full} />}>{t("result")}</BlockLabel>
        {extras}
        <div
          tabIndex={0}
          className="reasoning-prose max-h-72 overflow-auto rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary/40 [&_img]:max-h-40 [&_img]:rounded-md"
        >
          <Markdown isStreaming={over && !showAll}>{body}</Markdown>
        </div>
        {over && (
          <TruncationNotice shown={OUTPUT_LIMIT} total={full.length} showAll={showAll} onToggle={() => setShowAll((v) => !v)} />
        )}
      </section>
    );
  }

  // When nothing structured matched but the text IS one JSON value, at least
  // show it re-indented, in mono: machine text earns the machine face, and a
  // single-line payload is unreadable at any font. Display shape only — the
  // copy button keeps the artifact byte-for-byte as the tool sent it.
  const pretty = parsed ? JSON.stringify(parsed, null, 2) : null;
  const shownText = pretty ?? full;
  const overPre = shownText.length > OUTPUT_LIMIT;
  const preBody = overPre && !showAll ? shownText.slice(0, OUTPUT_LIMIT) : shownText;

  return (
    <section>
      <BlockLabel action={<CopyButton text={full} />}>{t("result")}</BlockLabel>
      {extras}
      {/* A failed command is a fact worth one calm sentence, not a red flood:
          exit code 1 is routine (grep with no match), so the surface below
          stays neutral and only this line carries the signal. */}
      {exitCode !== null && <p className="mb-1 text-[11px] text-destructive">{t("exitCode", { code: exitCode })}</p>}
      {/* A quiet tinted surface, nothing more. It used to carry a 2px left rule,
          but an edge butted against a rounded corner reads as a printing defect,
          not a device — the label above already says "this came back", and the
          tint alone separates it from the page. */}
      <div className={`rounded-lg px-2.5 py-1.5 ${isError ? "bg-destructive/10" : "bg-muted/50"}`}>
        {/* tabIndex on a scrollable region: without it a keyboard user cannot reach
            the part of a long output that is scrolled out of view (WCAG 2.1 AA). */}
        <pre
          tabIndex={0}
          className={`max-h-56 overflow-auto whitespace-pre-wrap break-words leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-primary/40 ${
            mono || pretty ? "font-mono text-[11px]" : "text-xs"
          } ${isError ? "text-destructive" : "text-muted-foreground"}`}
        >
          {preBody}
        </pre>
      </div>
      {overPre && (
        <TruncationNotice shown={OUTPUT_LIMIT} total={shownText.length} showAll={showAll} onToggle={() => setShowAll((v) => !v)} />
      )}
    </section>
  );
}

/** A record list result, rendered to be READ: the record's first field is its
 *  heading (linked when the record carries a URL), long fields flow as quiet
 *  text, and everything short collapses into one dim metadata line. Which field
 *  plays which role is decided by SHAPE — position, length, being a URL — never
 *  by the field's name, so an unknown tool's list renders as well as a known
 *  one's. Every field the tool sent is on screen; nothing is dropped. */

function RecordList({ records }: { records: TextRecord[] }) {
  const t = useTranslations("chat.tool");
  // Bounded like every other result surface: the container scrolls, and past
  // a page of records the tail is a stated count, not an endless render.
  const shown = records.slice(0, 25);

  // Homogeneous short records — a query's row set — read as a table; the wide
  // case scrolls inside this container, never the page.
  if (readsAsTable(shown)) {
    return (
      <div
        tabIndex={0}
        className="max-h-72 overflow-auto rounded-lg bg-muted/50 px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        <table className="min-w-full text-xs">
          <thead>
            <tr>
              {shown[0].fields.map((f) => (
                <th key={f.label} className="whitespace-nowrap px-2 py-1 text-left text-[11px] font-medium text-muted-foreground">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-t border-border/60">
                {r.fields.map((f, j) => (
                  <td key={j} className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                    {f.url ? (
                      <a href={f.value} target="_blank" rel="noopener noreferrer" className="text-link underline-offset-2 hover:underline">
                        {hostOf(f.value) ?? f.value}
                      </a>
                    ) : (
                      f.value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {records.length > shown.length && (
          <p className="mt-2 text-[11px] text-muted-foreground">{t("more", { count: records.length - shown.length })}</p>
        )}
      </div>
    );
  }

  return (
    <div
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-lg bg-muted/50 px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
    >
      <ol className="space-y-3">
        {shown.map((r, i) => {
          const [head, ...rest] = r.fields;
          const link = r.fields.find((f) => f.url)?.value;
          const body = rest.filter((f) => !f.url && !f.mono && f.value.length > 80);
          const meta = rest.filter((f) => !body.includes(f));
          return (
            <li key={i} className="min-w-0">
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-medium leading-snug text-link [overflow-wrap:anywhere] underline-offset-2 hover:underline"
                >
                  {head.value}
                </a>
              ) : (
                <div className="text-[13px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{head.value}</div>
              )}
              {body.map((f, j) => (
                <p key={j} className="mt-0.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  {f.value}
                  {f.clipped ? ` ${t("clippedField")}` : ""}
                </p>
              ))}
              {meta.length > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground/80 [overflow-wrap:anywhere]">
                  {meta.map((f, j) => (
                    <span key={j}>
                      {j > 0 && " · "}
                      {f.url ? (
                        // A secondary URL earns a link but not its whole address:
                        // the hostname is the part a reader acts on.
                        <a href={f.value} target="_blank" rel="noopener noreferrer" className="underline decoration-border underline-offset-2 hover:text-foreground">
                          {hostOf(f.value) ?? f.label}
                        </a>
                      ) : (
                        `${f.label} ${f.value}`
                      )}
                    </span>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {records.length > shown.length && (
        <p className="mt-2 text-[11px] text-muted-foreground">{t("more", { count: records.length - shown.length })}</p>
      )}
    </div>
  );
}

/** "Showing 2,000 of 18,240 characters · Show all" — the line that stops a
 *  clamped block from passing itself off as a complete one. Shared by the two
 *  blocks that clamp, so they cannot drift into describing the same thing
 *  differently. */
function TruncationNotice({ shown, total, showAll, onToggle }: { shown: number; total: number; showAll: boolean; onToggle: () => void }) {
  const t = useTranslations("chat.tool");
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {!showAll && <span>{t("truncated", { shown, total })}</span>}
      <button
        type="button"
        onClick={onToggle}
        className="rounded-md font-medium underline-offset-2 transition-colors hover:text-foreground hover:underline"
      >
        {showAll ? t("showLess") : t("showAll")}
      </button>
    </div>
  );
}

/** The heading over one block inside a step's panel. Sentence case and muted —
 *  deliberately not the uppercase letter-spaced "eyebrow", which is on CLAUDE.md's
 *  list of the generic-SaaS tells this product avoids. It has exactly one job:
 *  say which of the two things you are looking at, the one that was sent or the
 *  one that came back. */
function BlockLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-1 flex min-h-[22px] items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

/** Wrap text in a fence long enough that its own content cannot break out.
 *  A fixed ``` is not safe here: file contents and command output routinely
 *  contain backticks, and a file that merely DOCUMENTS a code block would
 *  otherwise terminate its own display halfway and spill the rest as markdown. */
function fence(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const bar = "`".repeat(longest + 1);
  return `${bar}${lang}\n${text}\n${bar}`;
}

/** One side of an edit. */
function DiffPane({ label, text, tone }: { label: string; text: string; tone: "before" | "after" }) {
  return (
    <div className={tone === "before" ? "bg-destructive/10" : "bg-success/10"}>
      <div className="px-2.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{label}</div>
      <pre
        tabIndex={0}
        className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        {/* A replacement that DELETES text leaves this side genuinely empty, which
            is the honest thing to show; the space only keeps the pane's height so
            the pair still reads as two panes rather than one with a stray label. */}
        {text || "\u00a0"}
      </pre>
    </div>
  );
}

/** What the model SENT, above what came back.
 *
 *  A result you cannot connect to a request explains nothing, and `execute_python`
 *  was the extreme case: the row said "Ran Python", the panel showed output, and
 *  the code itself appeared NOWHERE in the interface. Rendered through the app's
 *  own <Markdown>, so highlighting, both colour themes and a copy button come from
 *  the same renderer the answers use rather than a second one written here. */
function Invocation({ inv }: { inv: StepInvocation }) {
  const t = useTranslations("chat.tool");
  const [showAll, setShowAll] = useState(false);

  if (inv.kind === "diff") {
    return (
      <section>
        <BlockLabel>{t("sent.changes")}</BlockLabel>
        {/* Two labelled panes, not an interleaved diff: the tool hands over whole
            before/after strings, so there is no line-level diff to draw without
            inventing one. The tints are a SECOND channel only — "Before"/"After"
            carry the meaning on their own, for a reader who cannot separate them. */}
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          <DiffPane label={t("before")} text={inv.before} tone="before" />
          <DiffPane label={t("after")} text={inv.after} tone="after" />
        </div>
      </section>
    );
  }

  // Generic tools (MCP connectors, plugins, anything new): their arguments come
  // pre-shaped as label/value fields, so a non-technical reader gets "query —
  // AI news this week" instead of a syntax-highlighted JSON block. The verbatim
  // JSON is still one click away — tucked, not gone, because it is the one
  // artifact an admin can act on.
  if (inv.kind === "fields") {
    return (
      <section>
        <BlockLabel>{t("sent.params")}</BlockLabel>
        <FieldsGrid fields={inv.entries} />
        <TechDetails json={inv.json} />
      </section>
    );
  }

  const over = inv.text.length > INVOCATION_LIMIT;
  const body = over && !showAll ? inv.text.slice(0, INVOCATION_LIMIT) : inv.text;

  return (
    <section>
      <BlockLabel>{t(`sent.${inv.titleKey}`)}</BlockLabel>
      <Markdown>{fence(body, inv.lang)}</Markdown>
      {over && (
        <TruncationNotice shown={INVOCATION_LIMIT} total={inv.text.length} showAll={showAll} onToggle={() => setShowAll((v) => !v)} />
      )}
    </section>
  );
}

/** Label/value rows for typed fields — the params view AND a single-object
 *  result share this one rendering, so "what was sent" and "what one entity
 *  came back as" read identically. fit-content caps the label column so one
 *  long name cannot shove every value off the readable line. */
function FieldsGrid({ fields }: { fields: StepField[] }) {
  const t = useTranslations("chat.tool");
  return (
    <dl className="grid grid-cols-[fit-content(10rem)_1fr] gap-x-4 gap-y-1 text-[13px]">
      {fields.map((f, i) => (
        <Fragment key={i}>
          <dt className="truncate text-muted-foreground">{f.label}</dt>
          <dd className={`min-w-0 [overflow-wrap:anywhere] ${f.mono ? "font-mono text-[11px] leading-relaxed text-muted-foreground" : "text-foreground"}`}>
            {f.url ? (
              <a href={f.value} target="_blank" rel="noopener noreferrer" className="text-link underline-offset-2 hover:underline">
                {f.value}
              </a>
            ) : (
              f.value
            )}
            {/* A stated cut, never a silent one — the same contract the
                clamped blocks keep via TruncationNotice. */}
            {f.clipped && <span className="text-muted-foreground"> {t("clippedField")}</span>}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** The verbatim JSON behind a fields view — folded by default because its only
 *  audience is someone debugging a connector, and rendered as a plain <pre>
 *  rather than through <Markdown>: the highlighter's header chrome (language
 *  tag, floating action pill) is exactly the "code editor in the chat" look the
 *  fields view exists to remove. */
function TechDetails({ json }: { json: string }) {
  const t = useTranslations("chat.tool");
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const over = json.length > INVOCATION_LIMIT;
  const body = over && !showAll ? json.slice(0, INVOCATION_LIMIT) : json;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md text-xs text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {t("techDetails")}
      </button>
      {open && (
        <>
          <div className="relative mt-1.5">
            <div className="absolute right-1 top-1"><CopyButton text={json} /></div>
            <pre
              tabIndex={0}
              className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
            >
              {body}
            </pre>
          </div>
          {over && (
            <TruncationNotice shown={INVOCATION_LIMIT} total={json.length} showAll={showAll} onToggle={() => setShowAll((v) => !v)} />
          )}
        </>
      )}
    </div>
  );
}

/** The file a step acted on, as a chip you can open.
 *
 *  Rendered as a SIBLING of the row's disclosure trigger, never inside it: the
 *  trigger is a <button>, and a button within a button is invalid HTML and
 *  unreachable by keyboard — a lesson this codebase already paid for once, in
 *  FileTile's `overlay` slot. The trigger covers the row from underneath instead
 *  (see StepRow), so both controls get their own tab stop and the whole row still
 *  expands. */
function StepFileChip({ path, name, chatId }: { path: string; name: string; chatId: string }) {
  const t = useTranslations("chat.tool");
  const { open } = usePreview();
  const file: PreviewFile = useMemo(() => ({ path, name, chatId }), [path, name, chatId]);
  return (
    <button
      type="button"
      onClick={() => open([file], 0)}
      title={t("openFile", { name })}
      aria-label={t("openFile", { name })}
      className="relative z-10 flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted py-0.5 pl-0.5 pr-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <FileThumb file={file} className="h-4 w-4 shrink-0 overflow-hidden rounded-[3px]" />
      <span className="truncate">{name}</span>
    </button>
  );
}

// --- Sub-components ---



/** Numbered search results inside a step panel — the list the reply's [N]
 *  chips point into: number, linked title, domain, clamped snippet. */
function SourceList({ sources }: { sources: NumberedSource[] }) {
  return (
    <ol className="space-y-1.5 rounded-lg bg-muted/50 px-3 py-2">
      {sources.map((s) => (
        <li key={s.n} className="flex min-w-0 items-baseline gap-2 text-sm">
          {/* bg-background inverts against the panel's muted/50 so the number is
              findable when matching a [N] chip back to its source; the min-width
              keeps one- and two-digit rows left-aligned. */}
          <span className="min-w-[1.5rem] shrink-0 rounded-full border border-border bg-background px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground">{s.n}</span>
          <span className="min-w-0">
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">{s.title}</a>
            {hostOf(s.url) && <span className="ml-1.5 text-xs text-muted-foreground">{hostOf(s.url)}</span>}
            {s.date && <span className="ml-1.5 text-xs text-muted-foreground">· {s.date}</span>}
            {s.snippet && <span className="line-clamp-2 block text-xs leading-relaxed text-muted-foreground">{s.snippet}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}


function TextContent({ text, isStreaming, chatId, touched, sources }: { text: string; isStreaming?: boolean; chatId?: string; touched?: string[]; sources?: NumberedSource[] }) {
  // `chat-prose` caps flowing text to a ~70ch measure (see globals.css) so long
  // answers stay in the comfortable reading band; code blocks and tables are
  // exempt and keep the full column width. 16px (text-base) is the readable
  // floor — 15px sat just under it for Cyrillic body with tall diacritics.
  // `data-streaming` drives a CSS-only caret on the last paragraph (globals.css).
  // The dissolving tail used for reasoning is deliberately NOT applied here: the
  // answer goes through Streamdown, so its trailing characters live inside
  // whatever element the markdown parser just produced and can't be wrapped
  // without re-implementing the renderer. A caret is the part that carries
  // information anyway — it marks the write head and blinks when it parks.
  return (
    <div className="chat-prose text-base leading-relaxed" data-streaming={isStreaming ? "" : undefined}>
      <Markdown isStreaming={isStreaming} chatId={chatId} sources={sources}>{text}</Markdown>
      {chatId && <WorkspaceLinks text={text} chatId={chatId} live={isStreaming} touched={touched} />}
    </div>
  );
}

/** Tier two: everything the turn changed that its reply never mentioned, behind
 *  one quiet row. Collapsed by default and deliberately understated — this tier
 *  answers "what else did it touch?", a question nobody asks on a good turn. It
 *  gets no count badge, no download-all and no thumbnails grid until opened, so a
 *  message that produced one result still LOOKS like it produced one result. */
function AlsoChanged({ paths, chatId }: { paths: string[]; chatId: string }) {
  const tw = useTranslations("chat.workspace");
  const anchorDisclosure = useDisclosureAnchor();
  const viewable: PreviewFile[] = useMemo(
    () =>
      paths
        .filter((p) => previewKind(p.split("/").pop() || p) !== null)
        .map((p) => ({ path: p, name: p.split("/").pop() || p, chatId })),
    [paths, chatId],
  );
  return (
    <Collapsible defaultOpen={false} onOpenChange={(_, d) => anchorDisclosure(d)}>
      {/* Same 40% resting chevron as the activity group and the step rows — one
          quiet level for "there is more here", not a third opacity in the mix. */}
      <CollapsibleTrigger className="group/also mt-2 inline-flex items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground transition-micro hover:text-foreground [&[data-panel-open]_.chevron]:rotate-90">
        <ChevronRight className="chevron h-3.5 w-3.5 shrink-0 opacity-40 transition-transform group-hover/also:opacity-100" />
        <span>{tw("alsoChanged", { count: paths.length })}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 flex flex-wrap gap-3">
          {paths.map((p) => (
            <SandboxFileTile key={p} file={{ path: p, name: p.split("/").pop() || p, chatId }} viewable={viewable} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The files a turn produced, in the two tiers `lib/chat/artifacts.ts` defines.
 *
 * Tier one is what the reply NAMES — tiles, a count, "download all". Tier two is
 * what the turn also changed on disk (`touchedFiles`), folded behind one quiet
 * row, because a directory listing cannot tell a result from a scratch file and
 * putting the two in one grid would make the "Files · N" heading a lie.
 *
 * When the reply names nothing at all, tier two is PROMOTED to tier one. That is
 * the case this whole mechanism exists for: an agent whose python script wrote
 * the .xlsx and whose reply is "Done!" used to leave the user with no file in
 * sight. A folded row would technically fix it while still hiding the answer, so
 * the rule is "show the best evidence available", not "only ever show named".
 */
function WorkspaceLinks({ text, chatId, live, touched }: { text: string; chatId: string; live?: boolean; touched?: string[] }) {
  const t = useTranslations("chat.tool");
  const tw = useTranslations("chat.workspace");
  // Re-scanning the message text on every render is wasteful; the artifact
  // paths only change when the text does. Shared with the Telegram channel so
  // both surface the same referenced files.
  const { paths, folded } = useMemo(() => {
    const named = extractWorkspacePaths(text);
    // A file the reply mentions by bare name is just as named as one written as a
    // full /workspace/ path — see splitTouchedByMention for why that matters more
    // the weaker the model is.
    const { mentioned, rest } = splitTouchedByMention(touched ?? [], text);
    const tierOne = [...named, ...mentioned.filter((p) => !named.includes(p))];
    // Nothing named at all: showing the fold alone would still hide the answer,
    // so the uncertain list becomes the primary one. Less good than a real result
    // list, strictly better than the empty space this used to leave.
    if (tierOne.length === 0) return { paths: rest, folded: [] as string[] };
    return { paths: tierOne, folded: rest };
  }, [text, touched]);
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
    // Name comes from the server (Content-Disposition), which knows the chat title.
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
        {paths.map((p, i) => (
          // Staggered pop, capped at four steps: the delay exists to make the row
          // read as arriving rather than blinking, and past ~240ms the last tile
          // is just late. A turn that produced twelve files should not make the
          // twelfth wait most of a second.
          <div key={p} className="animate-pop-in" style={{ animationDelay: `${Math.min(i, 4) * 60}ms` }}>
            <SandboxFileTile file={{ path: p, name: p.split("/").pop() || p, chatId }} viewable={viewable} verify live={live} />
          </div>
        ))}
      </div>
      {folded.length > 0 && <AlsoChanged paths={folded} chatId={chatId} />}
    </div>
  );
}


/** The model's reasoning — a node on the same rail as the tool actions, marked
 *  with a lightbulb. The thought text shows inline: the surrounding ActivityGroup
 *  owns the collapse, so once a run is expanded the user reads the thinking
 *  directly (no second click). The badge tops-aligns to the first line so it
 *  reads as a paragraph annotation rather than a centred single-line row.
 *
 *  The text renders plainly, with no "still arriving" treatment: a reasoning part
 *  carries no streaming/done state (`contracts.ts`), so the dissolving tail this
 *  used to have was driven by position in the rail and sat frozen over final text
 *  whenever the model paused before answering. Liveness is already carried by the
 *  group header's ticking duration and the running step's spinner.
 *
 *  It renders as markdown, not as a pre-wrapped text node: models write `**bold**`
 *  pseudo-headings, lists and fenced code straight into their thoughts, and left
 *  unparsed those markers are the loudest thing on the row. `reasoning-prose`
 *  (globals.css) flattens the heading scale back to this row's own size —
 *  Streamdown types an `h1` at `text-3xl`, which would set a thought bigger than
 *  the answer it precedes. No `chatId`: /workspace chips belong to the answer,
 *  where a file mention is something to act on, not to a thought about one. */
function ReasoningRow({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  // Strip leaked chain-of-thought wrapper tags and the extra leading break some
  // models open a thought with — recomputed only when the streamed text grows.
  const clean = useMemo(() => cleanReasoning(text), [text]);
  return (
    <div className="animate-step-in relative py-1 pl-10 text-muted-foreground">
      {/* No pulse on the badge while streaming: the group header above already
          ticks a live duration and the rail shows a spinner on the running step.
          Three motions for one fact reads as a busy interface, not an
          informative one. */}
      <span className="absolute left-0 top-1 grid h-[27px] w-[27px] place-items-center rounded-full border border-border bg-card text-muted-foreground">
        <Lightbulb className="animate-step-in h-3.5 w-3.5" />
      </span>
      {/* Not italic: Onest ships no true italic, so Cyrillic reasoning came out
          mechanically slanted — the same reason blockquotes dropped italic in
          globals.css. Reasoning is already set apart by the rail and the muted
          colour; it doesn't need a second, worse-legibility signal. */}
      <div className="reasoning-prose text-sm leading-relaxed">
        <Markdown isStreaming={isStreaming}>{clean}</Markdown>
      </div>
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
          className="animate-step-in grid h-full w-full place-items-center text-[11px] font-bold text-white"
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
      <Icon className="animate-step-in h-3.5 w-3.5" />
    </span>
  );
}

/** One step on the rail: badge + intent label + optional dim detail, with the
 *  output/error tucked into a click-to-expand block beneath it. */
function StepRow({ part, chatId }: { part: ToolPart; chatId?: string }) {
  const tSteps = useTranslations("steps");
  const anchorDisclosure = useDisclosureAnchor();
  const t = useTranslations("chat.tool");
  const rawName = getToolName(part);
  const d = describeStep(tSteps, rawName, part.input);
  const state: "running" | "error" | "done" =
    part.state === "output-error" ? "error" : part.state.startsWith("output-") ? "done" : "running";
  const isRunning = state === "running";
  const isError = state === "error";
  // A demoted `manage` result (an applied change / diagnostic that isn't a card)
  // carries a ready, localized one-liner — show it as the label and drop the raw
  // JSON expander, so the timeline reads cleanly instead of "Manage" + a blob.
  const manageLabel = !isRunning && !isError && rawName === "manage" ? manageStepLabel(part.output, tSteps) : null;
  const doneLabel = manageLabel ?? d.label;
  const label = isRunning ? d.activeLabel : doneLabel;

  // The two halves of the panel, each computed once. `inv` is suppressed while the
  // call is still in an input-* state: arguments stream in character by character,
  // so a running step's args are a prefix of themselves, and showing a prefix of a
  // program as though it were the program is worse than showing nothing.
  const inv = useMemo(
    () => (part.state.startsWith("input-") ? null : describeInvocation(rawName, part.input)),
    [part.state, rawName, part.input],
  );
  const outText = useMemo(() => formatValue(part.output), [part.output]);

  // Now true when there is only an INVOCATION and no output: "Ran Python" with an
  // empty result used to be an inert row with nothing behind it, which is exactly
  // the step whose code you most want to see.
  const expandable = !isRunning && rawName !== "manage" && (!!outText || !!inv || !!part.errorText);

  // A failed step opens itself. It is the one row on the rail that the reader
  // definitely needs, and it was the one row folded away behind a chevron.
  // An effect rather than an initial value because a step usually starts running
  // and fails later, long after this component first mounted.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (isError) setOpen(true);
  }, [isError]);

  const fileChip =
    d.file && d.detail && chatId ? <StepFileChip path={d.file} name={d.detail} chatId={chatId} /> : null;
  // Tells you whether opening this is worth it, before you open it — and only
  // when that question has an answer worth printing. Below a handful of lines
  // everything is worth opening, so a count there is a number per row that
  // decides nothing; on a twelve-step turn that is twelve of them.
  const lines = outText ? outText.split("\n").length : 0;
  const showLineCount = lines >= 5;

  const row = (
    <div
      className={`animate-step-in relative flex min-h-[34px] items-center gap-3 py-1 pl-10 ${
        isError ? "text-destructive" : isRunning ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <StepBadge d={d} state={state} />
      {/* The disclosure trigger lies UNDER the row's content rather than wrapping
          it. Wrapping was fine while the row held only text, but the file chip is
          a real button now, and a button inside a button is invalid HTML and
          unreachable by keyboard. As siblings, each control gets its own tab stop
          and the whole row still expands. The content above it is inert
          (`pointer-events-none`) so clicks fall through to this. */}
      {expandable && (
        <CollapsibleTrigger
          aria-label={label}
          // Starts AFTER the 27px badge (badge + a 7px breath), not at inset-0:
          // painted later in DOM order, a full-bleed trigger put its hover wash
          // OVER the badge and across the rail line — an opaque pill swallowing
          // the one icon that says what the step is. The icon strip gives up its
          // few pixels of click target so the wash reads as "this row's text
          // expands", which is the true claim.
          className="absolute inset-y-0 left-[34px] right-0 z-0 rounded-lg transition-micro hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      )}
      <span className="pointer-events-none relative z-10 text-sm">
        {label}
        {isError ? ` · ${t("failed")}` : ""}
      </span>
      {/* The literal thing acted on — a filename, a command — gets its own chip
          rather than trailing the sentence as dim text. The chip is what makes
          the row LESS technical, not more: it reads as "machine detail,
          skippable", so the eye can take the sentence in the user's own language
          and skip the token, instead of having to parse a mono fragment spliced
          into the middle of a phrase.
          Styled as INLINE CODE (globals.css `[data-streamdown="inline-code"]`).
          A filename is the same kind of thing here as it is in the answer's
          prose, so it looks the same in both. When we know WHICH file it is, the
          chip earns a thumbnail and opens it. */}
      {fileChip ??
        (d.detail && (
          <span className="pointer-events-none relative z-10 min-w-0 truncate rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {d.detail}
          </span>
        ))}
      <span className="pointer-events-none relative z-10 ml-auto flex shrink-0 items-center gap-2">
        {expandable && showLineCount && (
          <span className="text-[11px] tabular-nums opacity-70">{t("outputLines", { count: lines })}</span>
        )}
        {expandable && (
          /* `opacity-40 → 100` on hover rather than hide-until-hover: an affordance
             nobody can see is an affordance nobody finds, so the chevron stays
             faintly present at rest and only firms up under the cursor. */
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 opacity-40 transition-transform group-hover/step:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        )}
      </span>
    </div>
  );

  if (!expandable) return row;

  return (
    // Controlled, because the chevron's rotation now has to be driven from React:
    // it is a SIBLING of the trigger, not a descendant, so the old
    // `[&[data-panel-open]_.chevron]` descendant selector can no longer reach it.
    <Collapsible
      open={open}
      onOpenChange={(next, details) => {
        setOpen(next);
        anchorDisclosure(details);
      }}
    >
      <div className="group/step">{row}</div>
      <CollapsibleContent>
        {/* Sent, then returned, in that order — the order they happened in. */}
        <div className="mb-2 ml-10 space-y-2.5">
          {inv && <Invocation inv={inv} />}
          <ToolDetails category={d.category} output={part.output} errorText={part.errorText} chatId={chatId} />
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
        <Check className="animate-step-in h-3.5 w-3.5" />
      </span>
      <span className="text-sm">{t("done")}</span>
    </div>
  );
}

/** Renders an interleaved run of reasoning + tool calls as one vertical step
 *  rail — a single thin line connecting each node, so thinking and actions read
 *  as one quiet "here's what I did" timeline rather than two different styles.
 *  A finished run is capped with a terminal "Done ✓" node. */
function ActivityRail({ items, isStreaming, chatId, sandboxPending }: { items: ActivityItem[]; isStreaming?: boolean; chatId?: string; sandboxPending?: boolean }) {
  const tStatus = useTranslations("chat.taskStatus");
  const rows = items.map((it, i) =>
    it.kind === "reasoning"
      ? <ReasoningRow key={`r${i}`} text={it.text} isStreaming={isStreaming} />
      : <StepRow key={it.part.toolCallId} part={it.part} chatId={chatId} />,
  );
  if (!isStreaming) rows.push(<DoneRow key="done" />);

  // Why the longest pause in the product gets a footnote and not a node: the
  // container is built FOR the step above — the first tool call that needs it —
  // so it is that step taking a while, not a separate thing happening. A node
  // would put a second spinner on screen for one piece of work, which is the
  // "pile of loaders" failure; a dim line at the tail adds the missing sentence
  // and nothing else. It sits OUTSIDE the rail wrapper so the connecting line's
  // geometry (bottom-4, measured to the last badge) stays exactly as it was.
  const note = isStreaming && sandboxPending ? (
    <div className="animate-step-in pl-10 text-xs text-muted-foreground">{tStatus("sandbox")}</div>
  ) : null;

  // A lone node needs no connecting line.
  if (rows.length === 1) return <>{rows}{note}</>;

  return (
    <>
      <div className="relative my-0.5">
        {/* the connecting line, centred under the 27px badges */}
        <div className="pointer-events-none absolute bottom-4 left-[13px] top-4 w-px bg-border" aria-hidden="true" />
        {rows}
      </div>
      {note}
    </>
  );
}

/** Wraps a run of reasoning + tool calls in a single quiet spoiler whose header
 *  reads, Grok-style, how long the run took — "Reasoned for 58s ›". Auto-opens
 *  while live and auto-collapses when the answer begins, with a manual click
 *  taking over.
 *
 *  `timing` is present on the ONE group that owns the turn's measured span (see
 *  the call site); every other group shows its action count and no duration,
 *  because no honest number exists for it. */
function ActivityGroup({ items, isStreaming, timing, chatId, sandboxPending }: { items: ActivityItem[]; isStreaming?: boolean; timing?: { measuredMs?: number; startedMsAgo?: number }; chatId?: string; sandboxPending?: boolean }) {
  const t = useTranslations("chat.message");
  const tDuration = useTranslations("chat.duration");
  const anchorDisclosure = useDisclosureAnchor();
  const streaming = !!isStreaming;
  const timed = timing != null;
  const { measuredMs, startedMsAgo } = timing ?? {};
  const [open, setOpen] = useState(streaming);
  // Whether the automatic collapse below should animate. An animation nobody can
  // see is not smoothness — it is 200ms of height interpolation, the most expensive
  // property there is, on the longest DOM in the app, plus a scroll correction on
  // every frame of it. At the end of a turn this block is usually far above the
  // reader (who is watching the answer), so the collapse is paid for and never
  // witnessed.
  const rootRef = useRef<HTMLDivElement>(null);
  const [instant, setInstant] = useState(false);
  // A ref, not state: once the reader has touched this spoiler the app stops
  // deciding for them, and that fact never needs to trigger a render.
  const userToggled = useRef(false);

  // A LAYOUT effect, not a render-phase branch. Measuring the DOM and queueing
  // state during render is something React explicitly forbids — a concurrent
  // render can be repeated or thrown away while the DOM it measured still belongs
  // to the previous commit, so the animate-or-not decision would sometimes be made
  // from stale geometry. Here the DOM is committed and known, both state writes
  // batch into one re-render, and that re-render lands before paint — so the panel
  // still closes with `data-collapse-instant` already applied and the transition
  // never starts.
  useIsomorphicLayoutEffect(() => {
    if (userToggled.current) return;
    // Never close under someone's hands: if focus is inside the panel, or they are
    // selecting text in it, the reader is plainly using it and the app's opinion
    // about tidiness does not outrank that.
    if (!streaming && rootRef.current && isReaderEngaged(rootRef.current)) return;
    const r = rootRef.current?.getBoundingClientRect();
    setInstant(!!r && (r.bottom <= 0 || r.top >= window.innerHeight));
    setOpen(streaming);
  }, [streaming]);

  // Live stopwatch for the turn in flight. It ticks from the run's REAL start,
  // not from this component's first paint: `startedMsAgo` says how long the turn
  // had already been going when the server built the snapshot we mounted from, so
  // rejoining a live turn (tab reopened, reconnect) reads the true elapsed
  // instead of restarting at zero.
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!timed || !streaming) return;
    if (startRef.current == null) startRef.current = Date.now() - (startedMsAgo ?? 0);
    const tick = () => setElapsed(Date.now() - startRef.current!);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timed, streaming, startedMsAgo]);

  // The server's own measurement wins the moment it exists — it timed the same
  // span in the one place that can see the whole run, whatever the client was
  // doing. The stopwatch above is only an estimate for a turn still in flight;
  // letting a frozen estimate outlive the real number is what left a wrong
  // duration sitting in the transcript for good.
  const ms = timed ? (streaming ? elapsed : measuredMs ?? elapsed) : null;
  const hasReasoning = items.some((it) => it.kind === "reasoning");
  const label =
    ms != null
      ? t(hasReasoning ? "reasonedFor" : "workedFor", { duration: formatShortDuration(ms, tDuration) })
      : streaming && hasReasoning
        ? t("thinking")
        : t(hasReasoning ? "reasoning" : "activity");
  // A bounded count is what makes a collapsed run understandable without opening
  // it: a duration alone says how long you waited, never how much happened. "6s ·
  // 4 actions" reads as complete and finite — the reassurance a user actually
  // needs before deciding NOT to expand. Suppressed while live (the number would
  // climb under the cursor), for pure-reasoning runs (nothing to count), and at
  // exactly one: "11s · 1 action" is two numerals fighting over one row to say
  // that there is nothing to enumerate. A count earns its place from two up.
  const toolCount = items.reduce((n, it) => (it.kind === "tool" ? n + 1 : n), 0);
  const countLabel = !streaming && toolCount > 1 ? t("stepCount", { count: toolCount }) : null;

  return (
    <Collapsible
      ref={rootRef}
      open={open}
      // A deliberate press is always animated — the reader is looking straight at
      // what they clicked, and that is the one place the growing-lid motion earns
      // its keep — and it hands the scroll position to the pressed row, so the
      // panel grows downward out of a control that does not move. Base UI tells us
      // the reason and the trigger, so a press and a collapse the app performed on
      // the reader's behalf are told apart by the library, not guessed at.
      onOpenChange={(v, details) => {
        anchorDisclosure(details);
        if (details.reason === "trigger-press") { userToggled.current = true; setInstant(false); }
        setOpen(v);
      }}
      data-collapse-instant={instant ? "" : undefined}
    >
      {/* No pulse on the label while live: the rail below is already open and
          shows a spinning node on the running step, so a pulsing header is the
          same fact stated a second time. `tabular-nums` keeps the ticking duration
          from reflowing the row a digit at a time. */}
      <CollapsibleTrigger className="group/act inline-flex max-w-full items-center gap-1.5 py-1 text-left text-sm text-muted-foreground transition-micro hover:text-foreground [&[data-panel-open]_.chevron]:rotate-90">
        <span className="min-w-0 truncate tabular-nums">{label}</span>
        {countLabel && (
          <span className="shrink-0 text-muted-foreground/70 tabular-nums">· {countLabel}</span>
        )}
        <ChevronRight className="chevron h-3.5 w-3.5 shrink-0 opacity-40 transition-transform group-hover/act:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5">
          <ActivityRail items={items} isStreaming={isStreaming} chatId={chatId} sandboxPending={sandboxPending} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Friendly, role-aware failure notice. Everyone sees `message`; admins can
 *  expand the raw technical `detail`. */
function ErrorNotice({ message, detail, isAdmin, ownsResource, partial, onContinue }: { message: string; detail?: string; isAdmin?: boolean; ownsResource?: boolean; partial?: boolean; onContinue?: (text: string) => void | Promise<boolean | void> }) {
  const t = useTranslations("chat.tool");
  const anchorDisclosure = useDisclosureAnchor();
  // One-shot: the click sends a real user turn, and until that turn's message
  // arrives this notice is still mounted. Without the latch a double-click asks
  // the model to continue twice.
  const [continued, setContinued] = useState(false);
  return (
    // A failure is a state of the turn, not a hazard sign taped over it. The old
    // pink slab with a hard red border was the loudest object in the transcript,
    // and it landed on someone who mostly just needs to press retry — so the panel
    // is now the same calm shell as everything else here, and ALL the red lives in
    // one 20px badge. That badge is the mirror of the rail's "Done ✓" node right
    // above it, which is what makes it legible at a glance rather than alarming.
    // Colour is never the only channel: role="alert", the mark, and the sentence.
    <div role="alert" className="mt-2 rounded-2xl bg-card px-3.5 py-3 shadow-panel">
      <div className="flex items-start gap-2.5 text-sm">
        {/* The badge is the whole tone of the notice, so it carries the one
            distinction that matters here: did the turn lose everything, or did it
            stop part-way with work still standing? A red ✕ on a turn that wrote
            five files says "nothing happened" and pushes the reader toward
            regenerating, which would redo it all. The part-way state gets the
            warning tone and an ellipsis — cut off mid-sentence, not broken — and
            keeps a border, because the amber surface is too light to read as a
            disc against the card on its own. */}
        {partial ? (
          <span
            aria-hidden
            className="animate-step-in mt-px grid size-5 shrink-0 place-items-center rounded-full border border-warning-border bg-warning-surface text-warning-text"
          >
            <MoreHorizontal className="h-3 w-3" strokeWidth={3} />
          </span>
        ) : (
          <span
            aria-hidden
            className="animate-step-in mt-px grid size-5 shrink-0 place-items-center rounded-full bg-destructive text-destructive-foreground"
          >
            <X className="h-3 w-3" strokeWidth={3.5} />
          </span>
        )}
        <span className="flex-1 leading-relaxed text-foreground">{message}</span>
      </div>
      {/* Offered only on the part-way state, and only where continuing is
          meaningful (the newest reply — see chat-panel). It sends an ordinary
          user message rather than resuming behind the scenes: the request stays
          visible in the transcript, which is also what makes it obvious this is
          "carry on", not the ↻ that starts the whole turn over. */}
      {partial && onContinue && (
        <div className="mt-2.5 ml-[30px]">
          <Button
            size="sm"
            disabled={continued}
            onClick={() => {
              // Disabled on click so a second press cannot queue a second turn, and
              // re-enabled if the send did not land — the composer gets the text back
              // in that case, so a permanently dead button is the only thing left
              // that a reload was needed to fix.
              setContinued(true);
              haptic("tap");
              void Promise.resolve(onContinue(t("continuePrompt"))).then(
                (ok) => { if (ok === false) setContinued(false); },
                () => setContinued(false),
              );
            }}
          >
            <ArrowRight className="h-3.5 w-3.5" />
            {t("continueTurn")}
          </Button>
        </div>
      )}
      {(isAdmin || ownsResource) && detail && detail !== message && (
        <Collapsible onOpenChange={(_, d) => anchorDisclosure(d)}>
          {/* Not red. Opening the raw detail is an ordinary affordance, and
              painting it with the error colour made the notice read as two
              alarms — one of which is just a disclosure triangle. */}
          <CollapsibleTrigger className="mt-2 ml-[30px] flex items-center gap-1 text-xs text-muted-foreground transition-micro hover:text-foreground [&[data-panel-open]>.chevron]:rotate-90">
            <ChevronRight className="chevron h-3 w-3 transition-transform" />
            {t("technicalDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            {/* Same code treatment as the step chip and the answer's inline code
                — read-only machine text is one thing throughout, and none of it
                is a field to type in. */}
            <pre className="mt-1.5 ml-[30px] max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-[11px] text-muted-foreground">
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
    // Blocked outright (permissions policy in an embed) — fail quietly rather
    // than claim a copy that didn't happen.
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    haptic("tap");
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Hint label={copied ? t("copied") : t("copy")}>
      <button
        type="button"
        onClick={onCopy}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </Hint>
  );
}

/** "‹ i/N ›" version switcher — shown only when a message has alternative
 *  siblings (from an edit or a regenerate). Flips the visible branch. */
function BranchSwitcher({
  index, count, messageId, onSwitch, disabled,
}: {
  index: number;
  count: number;
  messageId: string;
  onSwitch: (messageId: string, direction: "prev" | "next") => void;
  disabled?: boolean;
}) {
  const t = useTranslations("chat.message");
  if (count <= 1) return null;
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground" aria-label={t("versions", { count })}>
      <Hint label={t("prevVersion")}>
        <button
          type="button"
          onClick={() => onSwitch(messageId, "prev")}
          disabled={disabled || index <= 0}
          className="rounded-md p-0.5 transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </Hint>
      <span className="tabular-nums">{index + 1}/{count}</span>
      <Hint label={t("nextVersion")}>
        <button
          type="button"
          onClick={() => onSwitch(messageId, "next")}
          disabled={disabled || index >= count - 1}
          className="rounded-md p-0.5 transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </Hint>
    </div>
  );
}


/** Fork from this message into a new chat — explore an alternative path without
 *  disturbing the current conversation. */
function ForkButton({ messageId, onFork, disabled }: { messageId: string; onFork: (messageId: string) => void; disabled?: boolean }) {
  const t = useTranslations("chat.message");
  return (
    <Hint label={t("fork")}>
      <button
        type="button"
        onClick={() => onFork(messageId)}
        disabled={disabled}
        className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      >
        <GitBranch className="h-3.5 w-3.5" />
      </button>
    </Hint>
  );
}

/** Same files, same order? Compared by sandbox name, which is what identifies a
 *  file to the model — an edit that only reordered nothing shouldn't cost a turn. */
function sameRefs(a: FileRef[], b?: { name: string; type: string }[]): boolean {
  const other = b ?? [];
  return a.length === other.length && a.every((r, i) => r.name === other[i].name);
}

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

/**
 * A message the user has typed but that hasn't been sent yet — it's waiting for
 * the running reply to finish. Drawn as the real bubble it is about to become,
 * held at reduced opacity and without the `shadow-panel` that makes a landed
 * message sit on the surface: in this system depth is what says "this is real",
 * so removing it (rather than adding a dashed border, which would read as a
 * developer tool) is what makes it read as not-yet-sent.
 *
 * The geometry, the file tiles and the files-only placeholder text are all
 * deliberately identical to {@link UserBubble}, so when the queue drains nothing
 * moves — the bubble just solidifies in place.
 */
export function QueuedBubble({
  text, refs, chatId, editing, onCancel, onEdit, onEditingChange,
}: {
  text: string;
  refs: { name: string; type: string }[];
  chatId: string;
  /** Owned by the panel, not by this bubble: the drain has to know that an edit
   *  is open so it doesn't send the message out from under the editor. */
  editing: boolean;
  /** Absent while the message is actually being sent: it's already on its way,
   *  so there is nothing left to cancel or rewrite. */
  onCancel?: () => void;
  onEdit?: (next: string, refs: FileRef[]) => void;
  onEditingChange?: (open: boolean) => void;
}) {
  const t = useTranslations("chat");
  const hasFiles = refs.length > 0;
  // Exactly what sendMessage will put in the real bubble for a files-only turn,
  // so the text doesn't change under the user at the moment it materialises.
  const shown = text || (hasFiles ? t("hook.processFiles") : "");

  if (editing) {
    return (
      // Full opacity while editing: you cannot ask someone to type into text
      // that has been deliberately dimmed. The ghost look returns on save.
      <div className="flex justify-end px-4 md:px-6 py-4">
        <div className="w-full max-w-[85%]">
          <MessageEditor
            chatId={chatId}
            initialText={text}
            initialFiles={refs}
            onSave={(next, nextRefs) => { onEdit?.(next, nextRefs); onEditingChange?.(false); }}
            onCancel={() => onEditingChange?.(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group/queued flex animate-message-in justify-end px-4 md:px-6 py-4">
      <div className="flex max-w-[75%] items-center gap-1.5 lg:max-w-[65%]">
        {onEdit && (
          <Hint label={t("panel.editQueued")}>
            <button
              type="button"
              onClick={() => onEditingChange?.(true)}
              className="shrink-0 rounded-full p-1.5 text-muted-foreground opacity-0 transition hover:bg-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover/queued:opacity-100 pointer-coarse:opacity-100"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </Hint>
        )}
        {onCancel && (
          <Hint label={t("panel.cancelQueued")}>
            <button
              type="button"
              onClick={onCancel}
              // Hover is the desktop affordance; touch has no hover, so coarse
              // pointers get it permanently rather than hiding the only way out.
              className="shrink-0 rounded-full p-1.5 text-muted-foreground opacity-0 transition hover:bg-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover/queued:opacity-100 pointer-coarse:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </Hint>
        )}
        {/* 65%, not less. Opacity dims the text AND the surface under it, so
            the two compound: measured against the real bubble's 18.6:1, this
            text lands at 5.8:1 — still plainly a ghost, but WCAG AA legible.
            At 55% it read beautifully and scored 4.1:1, which is a fail. */}
        <div className="flex min-w-0 flex-col items-end opacity-65 transition-opacity duration-200 group-hover/queued:opacity-90 group-focus-within/queued:opacity-90">
          {hasFiles && <MessageAttachments chatId={chatId} files={refs} />}
          <div className="inline-block max-w-full rounded-2xl bg-card px-5 py-3 text-[15px] text-card-foreground">
            {/* The clamp lives on the INNER box: `line-clamp` sets
                `display:-webkit-box`, which would override the bubble's
                `inline-block` and stretch it to the full column width instead
                of hugging its text. Clamped at all because the composer strip
                this replaced was a single truncated line — an unclamped paste
                would push the very reply it is queued behind off the screen.
                The full text shows the moment it's sent. */}
            <div className="line-clamp-5 whitespace-pre-wrap break-words">{shown}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The one caption under a run of queued messages — what happens next, and the
 * way out of waiting for it. It belongs to the GROUP, not to any one bubble:
 * three pending messages share one turn and one explanation, not three.
 *
 * Kept outside the dimmed bubble on purpose — this is the app talking, and
 * inside the ghost it measured 2.5:1 against a 4.5:1 bar.
 */
export function QueuedCaption({
  count, held, onSendNow,
}: {
  count: number;
  /** An editor is open, so the drain is deliberately parked. */
  held: boolean;
  /** Absent when there is nothing to interrupt (or when interrupting would be
   *  wrong — see the panel: a turn awaiting an approval is waiting on the user,
   *  and cancelling it would throw away the very question being asked). */
  onSendNow?: () => void;
}) {
  const t = useTranslations("chat.panel");
  return (
    <div className="flex justify-end gap-2 px-4 md:px-6 pb-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Clock className="h-3 w-3 shrink-0" />
        <span>{held ? t("queuedHeld") : t("queuedHint", { count })}</span>
      </span>
      {onSendNow && !held && (
        <button
          type="button"
          onClick={onSendNow}
          title={t("queuedSendNowTitle")}
          className="rounded-md px-1.5 underline decoration-dotted underline-offset-4 transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {t("queuedSendNow")}
        </button>
      )}
    </div>
  );
}

/** A user message bubble. With `onEdit` it gains an inline editor: the pencil
 *  opens the shared {@link MessageEditor} — text and files together — and saving
 *  re-runs the conversation from that point. */
function UserBubble({
  text, messageId, timestamp, isTelegram, siblingIndex, siblingCount, chatId, attachedFiles, onEdit, onSwitchBranch, onFork, actionsDisabled, enter,
}: {
  text: string;
  messageId: string;
  timestamp: string;
  isTelegram: boolean;
  siblingIndex: number;
  siblingCount: number;
  chatId?: string;
  attachedFiles?: { name: string; type: string }[];
  onEdit?: (messageId: string, newText: string, refs: FileRef[]) => void;
  onSwitchBranch?: (messageId: string, direction: "prev" | "next") => void;
  onFork?: (messageId: string) => void;
  actionsDisabled?: boolean;
  enter?: boolean;
}) {
  const tMsg = useTranslations("chat.message");
  const [editing, setEditing] = useState(false);
  // Opening and closing the editor changes this message's height, so the reader's
  // place is handed to the scroll engine rather than left to the browser — the
  // same treatment a reasoning block's disclosure gets.
  const anchorDisclosure = useDisclosureAnchor();
  const editTriggerRef = useRef<HTMLElement | null>(null);
  const openEditor = (trigger?: HTMLElement | null) => {
    editTriggerRef.current = trigger ?? null;
    setEditing(true);
    anchorDisclosure({ reason: "trigger-press", trigger: trigger ?? undefined });
  };
  const closeEditor = () => {
    setEditing(false);
    anchorDisclosure({ reason: "trigger-press", trigger: editTriggerRef.current ?? undefined });
  };

  // The edit/fork actions sit hidden until hover on the web; touch has no hover,
  // so a long-press opens a labelled action menu anchored to the message (Base UI
  // handles the dismiss-on-outside-tap and focus). Clearer than silently
  // un-hiding the tiny icon row.
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPress(() => { setMenuOpen(true); haptic("tap"); });

  if (editing) {
    return (
      <div className="group/msg flex animate-message-in justify-end px-4 md:px-6 py-4">
        <div className="w-full max-w-[85%]">
          <MessageEditor
            chatId={chatId ?? ""}
            initialText={text}
            initialFiles={attachedFiles}
            onSave={(next, refs) => {
              // Unchanged in both text and files → nothing to re-run. Re-running
              // would branch the conversation and spend a turn to arrive at the
              // same question.
              const same = next === text && sameRefs(refs, attachedFiles);
              if (!same) onEdit?.(messageId, next, refs);
              closeEditor();
            }}
            onCancel={closeEditor}
          />
        </div>
      </div>
    );
  }

  const hasFiles = !!chatId && !!attachedFiles && attachedFiles.length > 0;

  const menuItems: ActionItem[] = [
    {
      key: "copy",
      icon: <Copy />,
      label: tMsg("copy"),
      hidden: !text,
      onSelect: () => void copyToClipboard(text),
    },
    {
      key: "edit",
      icon: <Pencil />,
      label: tMsg("edit"),
      hidden: !onEdit || !text,
      disabled: actionsDisabled,
      onSelect: () => openEditor(),
    },
    {
      key: "fork",
      icon: <GitBranch />,
      label: tMsg("fork"),
      hidden: !onFork,
      disabled: actionsDisabled,
      onSelect: () => onFork?.(messageId),
    },
  ];

  return (
    <div
      // `enter === false` for a message that was already on screen as a queued
      // ghost. The entrance animation starts from opacity 0, so replaying it
      // there would dip the bubble 0.55 → 0 → 1 at the exact moment it is
      // supposed to read as solidifying — a blink, not an arrival.
      className={`group/msg flex justify-end px-4 md:px-6 py-4 pointer-coarse:select-none ${enter === false ? "" : "animate-message-in"}`}
      {...longPress}
    >
      <ActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={text ? text.slice(0, 120) : undefined}
        ariaLabel={tMsg("actions")}
        items={menuItems}
        contentProps={{ align: "end", side: "bottom", className: "min-w-40" }}
      >
        <div className="relative flex max-w-[75%] flex-col items-end lg:max-w-[65%] [-webkit-touch-callout:none]">
          {/* Invisible anchor for the long-press menu. pointer-events-none so it
              never opens on a normal tap — only the long-press (setMenuOpen). */}
          <DropdownMenuTrigger
            aria-hidden
            tabIndex={-1}
            nativeButton={false}
            render={<span />}
            className="pointer-events-none absolute right-2 bottom-1 h-0 w-0"
          />
          {hasFiles && <MessageAttachments chatId={chatId!} files={attachedFiles!} />}
          {/* When the turn is files-only, the thumbnails are the content — skip the
              empty "…" bubble. */}
          {(text || !hasFiles) && (
            <div className="inline-block whitespace-pre-wrap break-words rounded-2xl bg-card text-card-foreground px-5 py-3 text-[15px] shadow-panel">
              {text || "…"}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1">
            {onSwitchBranch && (
              <BranchSwitcher index={siblingIndex} count={siblingCount} messageId={messageId} onSwitch={onSwitchBranch} disabled={actionsDisabled} />
            )}
            {/* Inline icons are the desktop (hover) affordance; touch uses the
                long-press menu instead, so these stay hover-only. */}
            {text && (
              <span className="opacity-0 transition group-hover/msg:opacity-100">
                <CopyButton text={text} />
              </span>
            )}
            {onEdit && text && (
              <span className="opacity-0 transition group-hover/msg:opacity-100">
                <Hint label={tMsg("edit")}>
                  <button
                    type="button"
                    onClick={(e) => openEditor(e.currentTarget)}
                    disabled={actionsDisabled}
                    className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </Hint>
              </span>
            )}
            {onFork && (
              <span className="opacity-0 transition group-hover/msg:opacity-100">
                <ForkButton messageId={messageId} onFork={onFork} disabled={actionsDisabled} />
              </span>
            )}
            <TimestampRow timestamp={timestamp} isTelegram={isTelegram} />
          </div>
        </div>
      </ActionMenu>
    </div>
  );
}

function TimestampRow({ timestamp, isTelegram }: { timestamp: string; isTelegram: boolean }) {
  const t = useTranslations("chat.message");
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground opacity-60 sm:opacity-0 transition-opacity duration-200 sm:group-hover/msg:opacity-100">
      {/* A status marker, not a control — so it carries its own role: the Hint
          puts the label on the span, and a bare <svg> would expose nothing. */}
      {isTelegram && (
        <Hint label={t("viaTelegram")}>
          <span role="img" className="inline-flex"><Send className="h-3 w-3" /></span>
        </Hint>
      )}
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
  usage?: { input: number; output: number; cached: number; cacheWrite?: number; reasoning?: number };
  costUsd?: number;
  /** Whether costUsd is the provider's billed charge or our catalog estimate. */
  costSource?: "provider" | "catalog";
  /** The real upstream that served the turn (OpenRouter routes one id to many). */
  upstreamProvider?: string;
  /** This turn has an OpenRouter generation → latency + provider chain are lazily
   *  fetchable from /api/messages/[id]/generation. */
  hasGeneration?: boolean;
  messageId?: string;
};

/** OpenRouter per-generation stats, fetched lazily when the popover opens. */
type GenStats = {
  available: boolean;
  pending?: boolean;
  provider?: string;
  latencyMs?: number;
  generationMs?: number;
  cacheDiscount?: number;
  finishReason?: string;
  chain?: { provider?: string; latencyMs?: number; status?: number }[];
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
  const { durationMs, model, usage, costUsd, costSource, upstreamProvider, hasGeneration, messageId } = details;

  // Latency + provider chain ride a separate, on-demand fetch (see the route):
  // only kicked off the first time the popover actually opens.
  const [gen, setGen] = useState<GenStats | null>(null);
  const [loadingGen, setLoadingGen] = useState(false);
  const fetchedRef = useRef(false);
  const loadGen = () => {
    // Latency + routing are admin-only plumbing (see the grouped block below), so
    // only an admin's open ever triggers the lookup.
    if (fetchedRef.current || !isAdmin || !hasGeneration || !messageId) return;
    fetchedRef.current = true;
    setLoadingGen(true);
    fetch(`/api/messages/${messageId}/generation`)
      .then((r) => (r.ok ? (r.json() as Promise<GenStats>) : null))
      .then((d) => {
        // Not propagated yet — let the next open retry instead of caching a miss.
        if (d?.pending) fetchedRef.current = false;
        setGen(d?.available ? d : null);
      })
      .catch(() => { fetchedRef.current = false; })
      .finally(() => setLoadingGen(false));
  };

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
  const ms = (n: number) => (n < 1000 ? `${nf.format(n)} ms` : t("durationSec", { s: (n / 1000).toFixed(1) }));
  // A fallback happened if OpenRouter tried more than one upstream this turn.
  const chain = gen?.chain?.filter((c) => c.provider) ?? [];

  return (
    <Popover onOpenChange={(open) => open && loadGen()}>
      <Hint label={t("show")}>
        <PopoverTrigger className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground data-[popup-open]:bg-accent/50 data-[popup-open]:text-foreground">
          <Info className="h-3.5 w-3.5" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent className="min-w-60 space-y-1.5 text-xs" side="top" align="start">
        {/* Everyone's view: plain, calm facts about the reply — nothing that reads
            as developer plumbing (cf. PRODUCT.md "hide the machinery"). */}
        {model && <DetailRow label={t("model")} value={model} />}
        {steps != null && steps > 0 && <DetailRow label={t("steps")} value={nf.format(steps)} />}
        {usage && <DetailRow label={t("inputTokens")} value={nf.format(usage.input)} />}
        {usage && <DetailRow label={t("outputTokens")} value={nf.format(usage.output)} />}
        {durationMs != null && <DetailRow label={t("duration")} value={formatDuration(durationMs, t)} />}
        {tokensPerSec != null && <DetailRow label={t("speed")} value={t("speedValue", { n: nf.format(tokensPerSec) })} />}
        <DetailRow label={t("sentAt")} value={exactTime} />

        {/* Admin technical block: the routing/cost/cache internals an operator
            cares about, walled off behind a labelled divider so the surface stays
            two clear sections rather than one undifferentiated dump. */}
        {isAdmin && (upstreamProvider || costUsd != null || (usage && (usage.reasoning || usage.cached || usage.cacheWrite)) || (hasGeneration && (loadingGen || gen))) && (
          <div className="mt-2 space-y-1.5 border-t pt-2">
            <div className="text-[0.6875rem] font-medium text-muted-foreground">{t("technical")}</div>
            {upstreamProvider && <DetailRow label={t("provider")} value={upstreamProvider} />}
            {costUsd != null && (
              <DetailRow
                label={t("cost")}
                // A catalog estimate is marked "≈" so it's never mistaken for the
                // billed amount; a provider-reported figure shows bare.
                value={`${costSource === "catalog" ? "≈ " : ""}${new Intl.NumberFormat(locale, {
                  style: "currency", currency: "USD", maximumFractionDigits: 4,
                }).format(costUsd)}`}
              />
            )}
            {usage && usage.reasoning != null && usage.reasoning > 0 && <DetailRow label={t("reasoningTokens")} value={nf.format(usage.reasoning)} />}
            {usage && usage.cached > 0 && <DetailRow label={t("cache")} value={nf.format(usage.cached)} />}
            {usage && usage.cacheWrite != null && usage.cacheWrite > 0 && <DetailRow label={t("cacheWrite")} value={nf.format(usage.cacheWrite)} />}
            {loadingGen && !gen && <div className="text-muted-foreground">{t("loadingRoute")}</div>}
            {gen?.latencyMs != null && <DetailRow label={t("latency")} value={ms(gen.latencyMs)} />}
            {gen?.generationMs != null && <DetailRow label={t("generationTime")} value={ms(gen.generationMs)} />}
            {chain.length > 1 && (
              <div className="space-y-1 pt-0.5">
                <span className="text-muted-foreground">{t("route")}</span>
                {chain.map((c, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-6 pl-2">
                    <span className="font-medium">{c.provider}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {c.latencyMs != null ? ms(c.latencyMs) : ""}
                      {c.status != null && c.status !== 200 ? ` · ${c.status}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// --- Main component ---

interface ChatMessageProps {
  message: UIMessage;
  isStreaming?: boolean;
  /** The turn is waiting on its sandbox container being built — surfaced as a
   *  dim footnote under the running step, since that step is what's blocked. */
  sandboxPending?: boolean;
  chatId?: string;
  isAdmin?: boolean;
  /** Provided only on the latest assistant reply — re-runs the same prompt. */
  onRegenerate?: () => void;
  /** Provided on user messages — replaces the text and re-runs from there. */
  onEdit?: (messageId: string, newText: string, refs: FileRef[]) => void;
  /** Flip between alternative versions of this message (edits/regenerations). */
  onSwitchBranch?: (messageId: string, direction: "prev" | "next") => void;
  /** Fork the conversation from this message into a new chat. */
  onFork?: (messageId: string) => void;
  /** A turn is streaming: edit/fork/branch/regenerate render disabled instead
   *  of unmounting — icons that vanish and reappear read as the UI glitching. */
  actionsDisabled?: boolean;
  /** Sends a message as the user — used by manage cards' confirm/undo buttons,
   *  so a config change is driven through the same chat turn (works in Telegram
   *  too, where the agent still holds the confirm/undo token in its context). */
  onSend?: (text: string) => void;
  /** False for a user message that the transcript already showed as a queued
   *  ghost — suppresses the entrance animation so it solidifies in place
   *  instead of blinking out and sliding back in. */
  enter?: boolean;
  /** Same sender as `onSend`, but provided only on the latest assistant reply, so
   *  the "continue" button on a part-way failure can't be offered on a turn the
   *  conversation has already moved past. */
  onContinue?: (text: string) => void | Promise<boolean | void>;
}

/** A compaction checkpoint in the transcript: a labelled divider where earlier
 *  history was collapsed into a summary. Click to expand the summary the model
 *  now sees in place of those turns — the full history above stays scrollable. */
function CompactionDivider({ summary }: { summary: string }) {
  const t = useTranslations("chat.message");
  const anchorDisclosure = useDisclosureAnchor();
  return (
    <Collapsible className="my-4 px-2" onOpenChange={(_, d) => anchorDisclosure(d)}>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <CollapsibleTrigger className="flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors hover:bg-hover">
          <span aria-hidden>📋</span>
          <span>{t("compacted")}</span>
        </CollapsibleTrigger>
        <div className="h-px flex-1 bg-border" />
      </div>
      <CollapsibleContent className="mt-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        <Markdown>{summary}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ChatMessageImpl({ message, isStreaming, sandboxPending, chatId, isAdmin, onRegenerate, onEdit, onSwitchBranch, onFork, actionsDisabled, onSend, onContinue, enter }: ChatMessageProps) {
  const locale = useLocale();
  const t = useTranslations("chat.message");
  const tTime = useTranslations("chat.time");
  const tErr = useTranslations("errors.llm");
  const isUser = message.role === "user";
  const metadata = message.metadata as
    | { createdAt?: string | null; platform?: string | null; taskStatus?: string | null; error?: string | null; errorDetail?: string | null; errorCategory?: string | null; errorOwned?: boolean | null; siblingIndex?: number; siblingCount?: number; attachedFiles?: { name: string; type: string }[]; durationMs?: number; reasoningMs?: number; runningMs?: number; model?: string; usage?: { input: number; output: number; cached: number; cacheWrite?: number; reasoning?: number }; costUsd?: number; costSource?: "provider" | "catalog"; upstreamProvider?: string; hasGeneration?: boolean; touchedFiles?: string[]; citedSources?: { n: number; title: string; url: string }[]; compaction?: { summary: string; summarizedUpTo: string; tokensSaved?: number } }
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
        actionsDisabled={actionsDisabled}
        enter={enter}
      />
    );
  }

  // Assistant — group consecutive parts: answer text stays on its own, while
  // runs of reasoning + tool calls merge into one "activity" rail so thinking
  // and actions read as a single timeline rather than two competing styles.
  const parts = message.parts;
  type Group =
    | { kind: "text"; text: string }
    | { kind: "activity"; items: ActivityItem[] }
    | { kind: "manage"; output: unknown }
    | { kind: "approval"; part: ToolPart }
    | { kind: "ask"; part: ToolPart };
  const groups: Group[] = [];
  for (const part of parts) {
    // A `manage` call suspended for native approval (and its resolved states) is
    // the user's one required action — it always renders as the prominent card.
    if (isToolPart(part) && isApprovalPart(part as ToolPart)) {
      groups.push({ kind: "approval", part: part as ToolPart });
      continue;
    }
    // An `ask` call suspended for a human answer — the question card, likewise the
    // user's one required action.
    if (isToolPart(part) && isAskPart(part as ToolPart)) {
      groups.push({ kind: "ask", part: part as ToolPart });
      continue;
    }
    // A completed `manage` result that's a confirmation or an applied change
    // escapes the quiet activity rail and renders as its own prominent card.
    if (isToolPart(part) && getToolName(part as ToolPart) === "manage" && isManageCard((part as ToolPart).output)) {
      groups.push({ kind: "manage", output: (part as ToolPart).output });
      continue;
    }
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
  const firstActivityIdx = groups.findIndex((g) => g.kind === "activity");

  // Every numbered source this turn's search results produced, plus the
  // resolved snapshot finalize persisted (`metadata.citedSources`) — numbers
  // are unique across the BRANCH, so a reply may cite a source a previous
  // turn's search minted, and only the snapshot carries those here. Own parts
  // win on a collision (they carry snippet/date; the snapshot is lean).
  // The footer lists only the cited subset.
  const turnSources: NumberedSource[] = [];
  for (const part of parts) {
    if (!isToolPart(part)) continue;
    const s = sourcesFromOutput((part as ToolPart).output);
    if (s) turnSources.push(...s);
  }
  for (const s of metadata?.citedSources ?? []) {
    if (!turnSources.some((t) => t.n === s.n)) turnSources.push(s);
  }
  const cited = turnSources.length
    ? citedSources(groups.filter((g) => g.kind === "text").map((g) => g.text).join("\n"), turnSources)
    : [];

  // An assistant turn that's still warming up (no parts yet) renders nothing —
  // the single "working…" indicator in the panel owns that state. Rendering an
  // empty padded bubble here would just shove the indicator down a notch the
  // moment the row is created, then again when the first step replaces it.
  if (!isUser && groups.length === 0 && isStreaming && metadata?.taskStatus !== "failed") {
    return null;
  }

  return (
    // `--table-bleed` is this element's own horizontal padding plus the list's
    // (px-2 in chat-panel) — the full distance from an answer's text to the
    // screen edge. A markdown table's scroll strip pulls itself out by exactly
    // that (globals.css) so it runs edge to edge on a phone. Zeroed from md up,
    // where the column is centred and that margin is deliberate empty space.
    <div className="group/msg px-4 md:px-6 py-4 [--table-bleed:1.5rem] md:[--table-bleed:0px]">
      <div className="max-w-none">
        {groups.length > 0 ? (
          groups.map((g, gi) => {
            // Each part settles in on mount (message-in) — new steps and text
            // surface live as they stream. Calm opacity+4px, never the cinematic
            // blur-rise: this block re-mounts as an answer grows, so blur here
            // would strobe on the hottest surface in the app.
            if (g.kind === "text") {
              const afterActivity = gi > 0 && groups[gi - 1].kind !== "text";
              return (
                <div key={gi} data-scroll-anchor="text" className={`animate-message-in ${afterActivity ? "mt-3 border-t border-border pt-3" : gi > 0 ? "mt-3" : ""}`}>
                  {/* `touchedFiles` belongs to the whole turn, not to one text
                      block, so it hangs off the LAST one — where the eye already
                      is when the answer ends. */}
                  <TextContent
                    text={g.text}
                    isStreaming={isStreaming && gi === lastTextIdx}
                    chatId={chatId}
                    touched={gi === lastTextIdx ? metadata?.touchedFiles : undefined}
                    sources={turnSources.length ? turnSources : undefined}
                  />
                </div>
              );
            }
            if (g.kind === "approval") {
              return <ApprovalCard key={gi} messageId={message.id} toolCallId={g.part.toolCallId} toolName={getToolName(g.part)} input={g.part.input} state={g.part.state} approval={g.part.approval} output={g.part.output} onSend={onSend} />;
            }
            if (g.kind === "ask") {
              // An `elicit:` toolCallId marks a block-and-poll MCP elicitation — the
              // answer routes to the row writer, not a suspended tool call.
              const kind = g.part.toolCallId?.startsWith("elicit:") ? "elicitation" : "ask";
              return <AskCard key={gi} messageId={message.id} toolCallId={g.part.toolCallId} form={g.part.askForm!} value={g.part.askValue} state={g.part.state} kind={kind} />;
            }
            if (g.kind === "manage") {
              return <ManageCard key={gi} output={g.output} onSend={onSend} chatId={chatId} />;
            }
            // No wrapper blur-rise here — the spoiler header animates itself in,
            // and on expand each rail row surfaces with .animate-step-in.
            return (
              <div key={gi} data-scroll-anchor="activity" className={gi > 0 ? "mt-1.5" : ""}>
                <ActivityGroup
                  items={g.items}
                  isStreaming={isStreaming && gi === lastIdx}
                  // Only the FIRST run of a turn gets a duration. `reasoningMs`
                  // measures start → first answer token, a span that is already
                  // over by the time a later run (a tool call after the answer
                  // began) starts — so printing it on every group repeated the
                  // same number down the message. Later runs show their action
                  // count, which is genuinely theirs.
                  timing={gi === firstActivityIdx ? { measuredMs: metadata?.reasoningMs, startedMsAgo: metadata?.runningMs } : undefined}
                  chatId={chatId}
                  sandboxPending={sandboxPending}
                />
              </div>
            );
          })
        ) : isStreaming || metadata?.taskStatus === "failed" ? null : (
          <span className="text-muted-foreground text-sm">
            {metadata?.taskStatus === "cancelled" ? t("cancelled") : "…"}
          </span>
        )}
        {cited.length > 0 && !isStreaming && <CitedSourcesFooter list={cited} />}
        {metadata?.taskStatus === "failed" && (
          <ErrorNotice
            message={
              metadata.errorCategory && LOCALIZED_ERROR_CATEGORIES.has(metadata.errorCategory)
                ? tErr(metadata.errorCategory)
                : metadata.error || t("genericError")
            }
            detail={metadata.errorDetail || undefined}
            isAdmin={isAdmin}
            ownsResource={metadata.errorOwned ?? undefined}
            // Every one of these means "the reply stops mid-way but stands" — the
            // notice offers Continue instead of the retry advice a real failure gets.
            partial={PARTIAL_ERROR_CATEGORIES.has(metadata.errorCategory ?? "")}
            onContinue={onContinue}
          />
        )}
        {!isStreaming && (() => {
          const copyText = groups.filter((g) => g.kind === "text").map((g) => g.text).join("\n\n").trim();
          return (
            // Arrives one `--settle` after the turn ends, not with it. This row
            // mounts in the same frame as the reasoning spoiler collapsing and the
            // produced-file tiles landing, and appearing mid-collapse is what made
            // the end of a turn read as a pile-up. Geometry first, trim after.
            <div className="animate-message-in mt-1 flex items-center gap-1 [animation-delay:var(--settle)]">
              {onSwitchBranch && (
                <BranchSwitcher index={siblingIndex} count={siblingCount} messageId={message.id} onSwitch={onSwitchBranch} disabled={actionsDisabled} />
              )}
              {copyText && <CopyButton text={copyText} />}
              {onRegenerate && (
                <Hint label={t("regenerate")}>
                  <button
                    type="button"
                    onClick={onRegenerate}
                    disabled={actionsDisabled}
                    className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </Hint>
              )}
              {onFork && <ForkButton messageId={message.id} onFork={onFork} disabled={actionsDisabled} />}
              <MessageDetails
                details={{ durationMs: metadata?.durationMs, model: metadata?.model, usage: metadata?.usage, costUsd: metadata?.costUsd, costSource: metadata?.costSource, upstreamProvider: metadata?.upstreamProvider, hasGeneration: metadata?.hasGeneration, messageId: message.id }}
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
// Checkpoint rows render as a transcript divider, not a bubble. Branching here —
// in the memo wrapper, which calls no hooks itself — keeps ChatMessageImpl free
// of a conditional return sitting between hook calls (rules-of-hooks).
export const ChatMessage = memo(function ChatMessage(props: ChatMessageProps) {
  const cpMeta = props.message.metadata as { compaction?: { summary: string } } | undefined;
  if (cpMeta?.compaction) return <CompactionDivider summary={cpMeta.compaction.summary} />;
  return <ChatMessageImpl {...props} />;
});
