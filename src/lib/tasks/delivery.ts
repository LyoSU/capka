/**
 * Where a finished task's result is delivered beyond the web UI (which always
 * gets it via realtime + the stored message). Today only Telegram needs an
 * outbound push; the sink interface keeps room for more channels (email,
 * Slack…) without the runner knowing any channel's specifics.
 *
 * Telegram delivery rides Bot API 10.1 Rich Messages: the agent's Markdown is
 * sent verbatim (`{ markdown }`) — Telegram renders headings, lists, tables,
 * code and quotes itself, so there is NO Markdown→HTML conversion here. Live
 * streaming uses `sendRichMessageDraft` (an ephemeral, animated 30s preview);
 * the final answer is persisted with `sendRichMessage`.
 */
import { InputFile, InlineKeyboard, GrammyError } from "grammy";
import { log } from "@/lib/log";
import { getTranslator, type Translator } from "@/lib/i18n/translator";
import type { Modality } from "@/lib/providers/registry";
import type { AskForm } from "@/lib/ask/types";

// `locale` carries the originating Telegram client's language so the bot's
// outbound text (status header, collapsed log, error fallbacks) matches what the
// user sees in the chat — falling back to English for anything we don't ship.
export type TaskOrigin = { platform: "telegram"; telegramChatId: number; locale?: string };

export interface TaskResult {
  status: "completed" | "failed" | "cancelled";
  text: string;
  /** The model's thinking, folded into a collapsed <details> block above the
   *  answer (mirrors the web, which shows reasoning collapsed). */
  reasoning?: string;
  /** The sources this reply actually cited (the [N] markers resolved against the
   *  turn's search results — the same subset the web footer lists). Rendered as
   *  a quoted "Sources:" block under the answer, so the naked [N] markers in the
   *  Telegram text mean something. URLs are http(s)-vetted upstream
   *  (sourcesFromOutput); titles are still web-page strings and are flattened
   *  here before touching Markdown. */
  sources?: { n: number; title: string; url: string }[];
  /** Friendly, user-facing error (set when status is "failed"). English fallback;
   *  prefer `errorCategory` for a localized message. */
  error?: string;
  /** LLM error category (e.g. "rate_limited") so the Telegram sink can localize the
   *  message via errors.llm.<category>, matching the web path — instead of shipping
   *  the English `error` string to a non-English user. */
  errorCategory?: string;
  /** Raw technical detail of a failure — surfaced in-chat to admins only, in a
   *  collapsed <details>, so they never have to open the web UI to diagnose. */
  errorDetail?: string;
  /** Whether the linked user is an admin (gates the technical error detail). */
  isAdmin?: boolean;
  /** Media modalities the chosen model couldn't take natively this turn (e.g. a
   *  voice note on a text-only model). Surfaced as a calm one-line heads-up above
   *  the answer, pointing at /model — the user otherwise can't tell the model
   *  never heard them. */
  blindModalities?: Modality[];
  /** A tool call the SDK SUSPENDED for the user's approval (native HITL) — a
   *  `manage` change, or any connector/skill call under a governance "ask".
   *  On Telegram the final message carries Approve/Reject buttons keyed to the
   *  assistant `messageId` — the tap (not the model) records the decision and
   *  resumes the turn, so this channel gets the same real approval boundary as web.
   *  The preview (`title`/before→after, the ⚠️ `impact`, and `body`/`items` — the
   *  full text/set being approved) travels too, so nobody approves a change blind.
   *  A gated tool has no staged diff: it sends `tool` (the human label of what
   *  would run) instead of `title`, and the title is localized here. `toolCallId`
   *  pins the tap to the exact suspended call (a step can hold several);
   *  `truncated` means the arguments did not fit the preview — the buttons are
   *  then withheld, because a cut argument list cannot be consented to. */
  approval?: { messageId: string; toolCallId?: string; title: string; tool?: string; before: string; after: string; impact?: string; body?: string; items?: string[]; truncated?: boolean };
  /** An `ask` tool call the runner SUSPENDED for a human answer. On Telegram this
   *  starts a sequential field-by-field collection (see ask-collect); `userId` owns
   *  the answer submission, `messageId` is the suspended assistant message. */
  ask?: { messageId: string; form: AskForm; userId: string };
}

/** The transient activity shown while the answer streams in. The live reasoning
 *  text is passed alongside (see `composeDraft`), so a "thinking" status just
 *  marks the phase; `label` is the same human-readable step text the web UI shows
 *  ("Running a command…", "Creating logo.svg…"), with an optional dim `detail`
 *  (e.g. the command). */
export type StreamStatus =
  | { kind: "thinking" }
  | { kind: "tool"; label: string; detail?: string }
  | undefined;

/** A draft is sent as Markdown normally, but as HTML when it needs the native
 *  <tg-thinking> block (which has no Markdown form and is draft-only). */
type DraftBody = { markdown: string } | { html: string };

// The native thinking block is the one place we emit HTML, so escape its text.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Keep the thinking block tidy (and well under the rich-message char limit) by
// showing only the tail of a long reasoning stream.
const THINKING_MAX_CHARS = 3000;

/** A file the assistant created or edited during the run, ready to deliver. */
export interface OutFile {
  name: string;
  data: Buffer;
}

/**
 * A channel the runner streams a task into. `push` is fire-and-forget and
 * coalesces internally (the runner calls it on every flush, ~10×/s) — it updates
 * the ephemeral, animated draft preview: the live reasoning (a <tg-thinking>
 * block) until the answer starts, then the answer-so-far. `finish` persists the
 * whole turn as ONE final (notifying) rich message exactly once, with the
 * reasoning folded into a collapsed <details> above it; `sendFiles` delivers any files
 * the run produced. The web sink is a no-op — the web UI already receives
 * everything over realtime and browses sandbox files directly, and renders the
 * whole turn as a single message.
 */
export interface DeliverySink {
  push(answer: string, reasoning: string, status: StreamStatus): void;
  finish(result: TaskResult & { toolCount: number; elapsedMs: number; reasoningMs?: number }): Promise<void>;
  sendFiles(files: OutFile[]): Promise<void>;
}

const NOOP_SINK: DeliverySink = { push() {}, async finish() {}, async sendFiles() {} };

export function makeDeliverySink(origin: TaskOrigin | undefined): DeliverySink {
  if (origin?.platform === "telegram") return new TelegramSink(origin.telegramChatId, origin.locale);
  return NOOP_SINK;
}

const TELEGRAM_LIMIT = 4000; // plain-text fallback chunk size (under the 4096 cap)
// Don't spam draft updates: Telegram animates same-id drafts, but flooding the
// API risks 429s. One update per ~800ms is smooth and safe.
const MIN_DRAFT_INTERVAL_MS = 800;
// A streamed draft is an ephemeral ~30s preview. During a long silent step (a
// slow tool with no output) no new push arrives, so re-send the last draft well
// inside that window to keep the thinking block from vanishing mid-work.
const DRAFT_KEEPALIVE_MS = 20_000;

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

/**
 * Whether Telegram ANSWERED and its answer proves the message was never posted —
 * the only case in which re-sending the same turn as plain text is one delivery
 * rather than two.
 *
 * A `GrammyError` IS that answer (`ok: false`), so nothing was created: rejected
 * Markdown entities (400), a Bot API server that has no rich messages at all (404 —
 * the compatibility path that makes the fallback worth having), a rate limit (429).
 * Everything else is ambiguous and must not be retried: grammY's `HttpError` means
 * no answer arrived, so the request may well have been received and the message
 * posted with only the response lost; a 5xx is the same ambiguity from the far side.
 *
 * Sending is an emission — it leaves the boundary inside which this process can undo
 * things — so an ambiguous outcome cannot be resolved by trying again. One delivery
 * that may have been missed beats two the user has to read.
 */
export function refusedDelivery(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code < 500;
}

/** Stable, non-zero 31-bit draft id. Same value across one response's updates
 *  (so Telegram animates them); distinct per response to avoid clashing. */
export function draftIdFrom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 1;
}

/** Streaming view. While NOTHING is written yet, the whole draft is the native,
 *  animated <tg-thinking> block — live reasoning text, or the active tool's step.
 *  Once ANY answer text exists, content wins: the draft is just the answer.
 *
 *  Content-wins is deliberate. An agentic turn alternates reasoning, tool calls
 *  and answer text; if we floated a reasoning/tool block above the already-shown
 *  answer it would jump in and out and merge thinking from separate phases — a
 *  visual mess as the model thinks again after a tool. So mid-answer activity
 *  stays out of the live view, and the reasoning is dropped entirely once the
 *  turn finishes (`composeFinal` keeps only the tool-log footer). Markdown isn't
 *  parsed inside <tg-thinking> (only HTML tags are), so the reasoning is
 *  HTML-escaped. */
export function composeDraft(answer: string, reasoning: string, status: StreamStatus, t: Translator): DraftBody {
  if (answer.trim()) return { markdown: answer };
  const think = reasoning.trim().slice(-THINKING_MAX_CHARS);
  const inner =
    status?.kind === "tool"
      ? `🔧 ${escapeHtml(status.label)}${status.detail ? ` — ${escapeHtml(status.detail)}` : ""}`
      : escapeHtml(think) || t("statusThinking");
  return { html: `<tg-thinking>${inner}</tg-thinking>` };
}

/** Final view: the answer verbatim, then a light one-line tool log
 *  ("✅ N tools · Ts") as a FOOTER when the turn ran any tools. The model's
 *  thinking is deliberately NOT folded into the final message — it lives only in
 *  the ephemeral streamed draft (see `composeDraft`); a stale reasoning dump
 *  under the answer adds noise without value.
 *  Footer, not header, deliberately: Telegram clients adopt the streamed draft
 *  into the final message by matching text PREFIXES, so the final must be the
 *  draft plus appended text — a header above the answer zeroes the prefix and
 *  the whole bubble repaints from scratch instead of "typing out" the summary. A
 *  header can't stream live either: tool count and duration only settle at the
 *  end of the turn. `doneLog` is an ICU plural string, so the tool-count grammar
 *  is correct in every locale. */
export function composeFinal(
  body: string,
  toolCount: number,
  elapsedMs: number,
  t: Translator,
): string {
  const log = toolCount > 0 ? t("doneLog", { count: toolCount, secs: Math.round(elapsedMs / 1000) }) : null;
  if (log) return body ? `${body}\n\n> ${log}` : `> ${log}`;
  return body;
}

/** The cited-sources footer: `[N] Title — URL` per line, in number order — the
 *  Telegram twin of the web reply's "Sources" list, and what turns the answer's
 *  naked [N] markers into resolvable footnotes. Titles come from arbitrary web
 *  pages, so they are flattened to one plain line (no newlines, links, or
 *  emphasis) before touching Markdown; the URL is sent bare and lets the client
 *  autolink it, which leaves no caption to spoof. A short list is a quoted
 *  block; past five sources it collapses behind <details> (the Bot API renders
 *  it as an expandable quotation), so a well-researched answer doesn't end in a
 *  screenful of links. The plain fallback always carries the flat lines. */
export function composeSources(
  sources: { n: number; title: string; url: string }[],
  t: Translator,
): { markdown: string; plain: string } {
  const line = (s: { n: number; title: string; url: string }) => {
    const title = s.title.replace(/\s+/g, " ").replace(/[[\]()`*_~>#|]/g, "").slice(0, 120).trim();
    return `[${s.n}] ${title ? `${title} — ` : ""}${s.url}`;
  };
  const lines = sources.map(line);
  const plain = [t("sourcesHeader"), ...lines].join("\n");
  const markdown = sources.length > 5
    ? `<details><summary>${escapeHtml(t("sourcesHeader"))} (${sources.length})</summary>\n\n${lines.join("\n")}\n\n</details>`
    : [`> ${t("sourcesHeader")}`, ...lines.map((l) => `> ${l}`)].join("\n");
  return { markdown, plain };
}

/** The confirm preview shown before a staged change is approved — the same
 *  consent contract on every channel. Everything the user must SEE to approve
 *  safely (the before→after diff, the ⚠️ impact warning, a skill's full body) is
 *  rendered into BOTH the rich markdown and the plain-text fallback, so a Markdown
 *  rejection can never silently strip the impact line or the body the web card shows. */
export function composeConfirmPreview(
  c: { title: string; tool?: string; before: string; after: string; impact?: string; body?: string; items?: string[]; truncated?: boolean },
  t: Translator,
): { markdown: string; plain: string } {
  // A gated tool call (governance "ask") arrives with only a `tool` label — the
  // localized question is composed here, where the channel's translator lives.
  const title = c.title || (c.tool ? t("approveTool", { tool: c.tool }) : "");
  const diff = c.before && c.before !== c.after ? `${c.before} → ${c.after}` : c.after;
  // Title + ⚠️ impact are consecutive blockquote lines → one quote block in rich md.
  const quote = [`> ${escapeHtml(title)}${diff ? `: ${escapeHtml(diff)}` : ""}`];
  const plain = [`${title}${diff ? `: ${diff}` : ""}`];
  if (c.impact) {
    quote.push(`> ⚠️ ${escapeHtml(c.impact)}`);
    plain.push(`⚠️ ${c.impact}`);
  }
  // The full SET being approved (e.g. every skill a repo installs) — listed on
  // every channel so a bulk install is never confirmed as an opaque "add repo".
  if (c.items?.length) {
    for (const it of c.items) quote.push(`> • ${escapeHtml(it)}`);
    plain.push(c.items.map((it) => `• ${it}`).join("\n"));
  }
  let markdown = quote.join("\n");
  if (c.body) {
    // The full text being approved (e.g. a SKILL.md), collapsed in rich md and
    // inline in the fallback — nobody confirms an unseen permanent instruction.
    markdown += `\n\n<details><summary>${escapeHtml(t("confirmDetails"))}</summary>\n\n${escapeHtml(c.body)}\n\n</details>`;
    plain.push(c.body);
  }
  if (c.truncated) {
    // The arguments were cut to fit — this channel gets no Approve/Reject buttons
    // (a cut call cannot be consented to), so say where the decision lives.
    markdown += `\n\n${escapeHtml(t("approveOnWeb"))}`;
    plain.push(t("approveOnWeb"));
  }
  return { markdown, plain: plain.join("\n\n") };
}

/** A failure rendered entirely in-chat, so the user never has to open the web UI
 *  to learn what went wrong. Everyone sees the calm `⚠️ userMessage`; an admin
 *  additionally gets the raw provider detail in a collapsed `<details>` (a code
 *  block, tail-capped) — the same role split the web shows, but self-contained
 *  in Telegram. */
export function composeError(
  userMessage: string,
  detail: string | undefined,
  isAdmin: boolean,
  t: Translator,
): string {
  const head = `⚠️ ${userMessage}`;
  const raw = (detail ?? "").trim();
  if (!isAdmin || !raw || raw === userMessage) return head;
  const code = escapeHtml(raw.slice(-1500));
  return `${head}\n\n<details><summary>${escapeHtml(t("technicalDetails"))}</summary>\n\n\`\`\`\n${code}\n\`\`\`\n\n</details>`;
}

class TelegramSink implements DeliverySink {
  private readonly draftId: number;
  private readonly t: Translator;
  /** Locale-scoped translator for the shared errors.llm.* catalog, so a failure
   *  reaches a non-English Telegram user localized (matching the web), not in the
   *  English userMessage baked into friendly.ts. */
  private readonly tErr: Translator;
  private pending: { answer: string; reasoning: string; status: StreamStatus } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  /** The draft HTTP call currently on the wire. finish() awaits it: a draft
   *  Telegram processes AFTER the final message re-creates the "streaming"
   *  bubble client-side, and it lingers ~30s as if the turn never ended. */
  private sending: Promise<unknown> | null = null;
  /** Whether any draft actually reached Telegram (gates the finish() bridge —
   *  with no draft on screen there is nothing to adopt). */
  private streamed = false;
  private lastSentAt = 0;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDraft: DraftBody | null = null;
  // Terminal latch. Set once finish() runs; afterwards NO draft, keepalive, or
  // bubble may ever be sent again. Without this, a keepalive `refresh()` whose
  // network await was in-flight when finish() ran would re-arm itself in its
  // `finally` — an immortal timer that keeps re-pushing the (already-answered)
  // draft long after the turn ended, so the reply appears to "come back" in the
  // chat over and over. The latch makes the sink's end-of-life irreversible.
  private closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;

  constructor(private readonly chatId: number, private readonly locale?: string) {
    this.draftId = draftIdFrom(`tg:${chatId}:${Date.now()}`);
    this.t = getTranslator(locale, "telegram");
    this.tErr = getTranslator(locale, "errors.llm");
  }

  // Dynamic import keeps the Telegram bot out of contexts that never deliver.
  private async getBot() {
    if (this.bot) return this.bot;
    const { getBot } = await import("@/lib/telegram/bot");
    this.bot = await getBot();
    return this.bot;
  }

  push(answer: string, reasoning: string, status: StreamStatus): void {
    if (this.closed) return; // a late push after finish must never resurrect drafts
    this.pending = { answer, reasoning, status };
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.inflight) return;
    const wait = Math.max(0, MIN_DRAFT_INTERVAL_MS - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.closed || !this.pending) return;
    const { answer, reasoning, status } = this.pending;
    this.pending = null;
    this.inflight = true;
    try {
      const bot = await this.getBot();
      if (!bot || this.closed) return; // finish() may have latched during the await
      if (!answer.trim() && !reasoning.trim() && !status) return; // nothing to show yet
      // Ephemeral animated preview; the real message is sent on finish().
      // `can_stop` (Bot API 10.3) puts a native stop button under the draft — the
      // tap arrives as a stopped_message_generation update (bot.ts) and flips the
      // same cooperative-cancel flag as the web stop button. `keep_on_stop` keeps
      // the partial visible until finish() persists it as a real message.
      const draft = composeDraft(answer, reasoning, status, this.t);
      const send = bot.api.sendRichMessageDraft(this.chatId, this.draftId, draft, { can_stop: true, keep_on_stop: true });
      this.sending = send;
      this.streamed = true;
      await send;
      this.lastSentAt = Date.now();
      this.lastDraft = draft;
      this.scheduleKeepalive();
    } catch (e) {
      // Non-fatal: the persisted finish() is what the user keeps.
      log.warn("telegram draft update failed", { chatId: this.chatId, err: String(e) });
    } finally {
      this.inflight = false;
      if (!this.closed && this.pending) this.schedule();
    }
  }

  // Re-send the last draft before its ~30s preview lapses, so the thinking block
  // stays put through long silent steps. Keeps rescheduling until finish().
  private scheduleKeepalive(): void {
    if (this.closed) return; // never (re)arm the loop once the turn has ended
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      void this.refresh();
    }, DRAFT_KEEPALIVE_MS);
  }

  private async refresh(): Promise<void> {
    // A queued push will send fresh content anyway — don't fight it. Once closed,
    // bail WITHOUT rescheduling so the loop dies for good.
    if (this.closed) return;
    if (!this.lastDraft || this.pending || this.inflight) {
      this.scheduleKeepalive();
      return;
    }
    try {
      const bot = await this.getBot();
      // finish() may have latched while we awaited the bot/network — re-check
      // before sending so we never re-push a draft for an already-ended turn.
      if (bot && !this.closed) {
        const send = bot.api.sendRichMessageDraft(this.chatId, this.draftId, this.lastDraft, { can_stop: true, keep_on_stop: true });
        this.sending = send;
        await send;
        this.lastSentAt = Date.now();
      }
    } catch (e) {
      log.warn("telegram draft keepalive failed", { chatId: this.chatId, err: String(e) });
    } finally {
      this.scheduleKeepalive(); // no-op once closed (guarded above)
    }
  }

  // Send one rich message, falling back to plain-text chunks when Telegram REFUSES
  // it (so a formatting quirk, or a Bot API server without rich messages at all,
  // never drops the message). `plain` is the markup-free text for that fallback;
  // `silent` suppresses the notification.
  private async sendRich(markdown: string, plain: string, silent: boolean, keyboard?: InlineKeyboard): Promise<void> {
    const bot = await this.getBot();
    if (!bot) return;
    const other = silent || keyboard
      ? { ...(silent ? { disable_notification: true } : {}), ...(keyboard ? { reply_markup: keyboard } : {}) }
      : undefined;
    // Clients "adopt" the streamed draft into the arriving real message by
    // matching text prefixes (there is no draft_id on sendRichMessage); a
    // final that doesn't extend the draft — capability notice prepended, an
    // error, a turn where the draft trailed the last flush — can leave the
    // draft as an orphaned "still streaming" bubble for ~30s next to the
    // answer. Bridge it: update the draft to the exact final markdown first,
    // making adoption a full match (and the summary footer visibly types out
    // as part of the stream instead of popping in with the final).
    if (this.streamed) {
      this.streamed = false;
      try {
        await bot.api.sendRichMessageDraft(this.chatId, this.draftId, { markdown });
      } catch (e) {
        log.warn("telegram draft bridge failed", { chatId: this.chatId, err: String(e) });
      }
    }
    try {
      await bot.api.sendRichMessage(this.chatId, { markdown }, other);
    } catch (e) {
      // Only re-send when Telegram's own answer proves nothing was posted. A lost
      // response or a 5xx leaves the outcome unknown, and a plain copy sent "just in
      // case" is a SECOND delivery of one turn — a duplicate the user reads and we
      // cannot take back. Prefer a silence the logs record.
      if (!refusedDelivery(e)) {
        log.error("telegram rich send failed with an unknown outcome; not re-sending", { chatId: this.chatId, err: String(e) });
        return;
      }
      log.warn("telegram refused the rich message; falling back to plain", { chatId: this.chatId, err: String(e) });
      try {
        // Keep the buttons on the plain-text fallback too — they're the whole point.
        const parts = chunk(plain, TELEGRAM_LIMIT);
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          await bot.api.sendMessage(this.chatId, parts[i], isLast ? other : (silent ? { disable_notification: true } : undefined));
        }
      } catch (e2) {
        log.error("telegram delivery failed", { chatId: this.chatId, err: String(e2) });
      }
    }
  }

  async finish(result: TaskResult & { toolCount: number; elapsedMs: number; reasoningMs?: number }): Promise<void> {
    // Idempotent + terminal. Latch BEFORE any await so a keepalive/flush whose
    // network call is in-flight sees `closed` the moment it resumes and refuses
    // to re-send. A second finish() (e.g. success path then a late catch) is a
    // no-op rather than a duplicate delivery.
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.pending = null;
    this.lastDraft = null;
    // Wait out a draft update already on the wire — processed after the final,
    // it would resurrect the (already-answered) streaming bubble for ~30s.
    if (this.sending) await this.sending.catch(() => {});
    if (result.status === "cancelled") {
      // A user-initiated stop (the web button, or Telegram's own stop button on
      // the draft). The web transcript keeps whatever was already written — this
      // channel now does too: the draft dies with the stop, so a non-empty
      // partial is re-sent as a real message with a quiet "stopped" footer.
      // Silent — the user just acted; a notification would echo their own tap.
      const partial = result.text.trim();
      if (partial) await this.sendRich(`${partial}\n\n> ${this.t("stopped")}`, `${partial}\n\n${this.t("stopped")}`, true);
      return;
    }

    // A failure is delivered in-chat, never deferred to the web UI: a calm
    // notice for everyone, plus a collapsed technical detail for admins.
    if (result.status !== "completed") {
      // Prefer the localized category message (matches the web); fall back to the
      // English userMessage, then a generic line.
      const userMessage = result.errorCategory
        ? this.tErr(result.errorCategory)
        : result.error || this.t("genericError");
      const markdown = composeError(userMessage, result.errorDetail, result.isAdmin ?? false, this.t);
      await this.sendRich(markdown, userMessage, false);
      return;
    }

    const body = result.text.trim();
    // The cited-sources block sits between the answer and the tool-log footer —
    // sources only make sense under text that cites them. The markdown side is a
    // quoted block; the plain fallback carries the SAME lines unquoted, so a
    // Markdown rejection never strips where the [N] markers point.
    const src = body && result.sources?.length ? composeSources(result.sources, this.t) : null;
    const mdBody = src ? `${body}\n\n${src.markdown}` : body;
    const plainBody = src ? `${body}\n\n${src.plain}` : body;
    let markdown: string | null;
    if (body) {
      // The whole answer, one message — closed with the tool-log footer.
      markdown = composeFinal(mdBody, result.toolCount, result.elapsedMs, this.t);
    } else if (result.toolCount > 0) {
      // Tools ran but the turn wrote no closing text — still cap the reply with a
      // "done" footer so it doesn't just trail off.
      markdown = composeFinal("", result.toolCount, result.elapsedMs, this.t);
    } else {
      markdown = `_${this.t("noText")}_`;
    }
    // Calm heads-up when the model couldn't see/hear an attachment — prepended so
    // the user learns it before reading a reply that ignored the file. Stands on
    // its own if there was no other text to send.
    const notice = result.blindModalities?.length
      ? this.t("capabilityNotice", {
          modalities: result.blindModalities.map((m) => this.t(`modality.${m}`)).join(", "),
        })
      : null;
    if (notice) markdown = markdown ? `${notice}\n\n${markdown}` : notice;

    // A suspended-for-answer turn (`ask`): send any preamble text, then start the
    // sequential field-by-field collection on this chat (see ask-collect). The
    // composer-block equivalent on Telegram is that a plain reply is routed to the
    // pending question until it's answered.
    if (result.ask) {
      if (body && markdown) await this.sendRich(markdown, plainBody, false);
      const bot = await this.getBot();
      if (bot) {
        const { startAskCollection } = await import("@/lib/telegram/ask-collect");
        await startAskCollection(bot, this.chatId, {
          userId: result.ask.userId, messageId: result.ask.messageId, form: result.ask.form, kind: "ask", locale: this.locale,
        });
      }
      return;
    }

    // A suspended-for-approval turn: append a compact before→after preview and
    // native Approve/Reject buttons. The tap (bound to this Telegram user) records
    // the decision and resumes the turn — the model can't, so Telegram gets the
    // same real approval boundary as web. Keyed to the assistant messageId (the
    // message has one pending call at a time), which fits the 64-byte callback.
    if (result.approval) {
      const c = result.approval;
      const { markdown: previewMd, plain: previewPlain } = composeConfirmPreview(c, this.t);
      markdown = markdown ? `${markdown}\n\n${previewMd}` : previewMd;
      // The plain-text fallback carries the SAME preview (diff + impact + body), so
      // a Markdown rejection never drops what the user needs to approve safely.
      const plain = plainBody ? `${plainBody}\n\n${previewPlain}` : previewPlain;
      // Truncated arguments = no buttons: what this channel can show is not the
      // whole call, so the decision belongs to the web card, which always is.
      // composeConfirmPreview already appended the pointer line.
      if (c.truncated) {
        await this.sendRich(markdown, plain, false);
        return;
      }
      // The tap decides the exact suspended call when its id fits Telegram's
      // 64-byte callback_data; otherwise it falls back to the first undecided
      // call — which is also the one this preview was built from (runner.ts).
      const withId = c.toolCallId && `ma:${c.messageId}:${c.toolCallId}`.length <= 64 ? `:${c.toolCallId}` : "";
      const keyboard = new InlineKeyboard()
        .text(this.t("confirmApply"), `ma:${c.messageId}${withId}`)
        .text(this.t("confirmCancel"), `mr:${c.messageId}${withId}`);
      await this.sendRich(markdown, plain, false, keyboard);
      return;
    }

    if (markdown) await this.sendRich(markdown, notice ? `${notice}\n\n${plainBody}` : plainBody || this.t("noText"), false);
  }

  async sendFiles(files: OutFile[]): Promise<void> {
    if (files.length === 0) return;
    const bot = await this.getBot();
    if (!bot) return;
    // Sent as documents to preserve the bytes exactly (no recompression);
    // Telegram still previews images and plays media inline. Best-effort per
    // file — one rejection must not block the rest.
    for (const f of files) {
      try {
        await bot.api.sendDocument(this.chatId, new InputFile(f.data, f.name));
      } catch (e) {
        log.warn("telegram file send failed", { chatId: this.chatId, name: f.name, err: String(e) });
      }
    }
  }
}
