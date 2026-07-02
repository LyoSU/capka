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
import { InputFile, InlineKeyboard } from "grammy";
import { log } from "@/lib/log";
import { getTranslator, type Translator } from "@/lib/i18n/translator";
import { formatShortDuration } from "@/lib/chat/duration";
import type { Modality } from "@/lib/providers/registry";

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
  /** A change the turn STAGED for the user to confirm. On Telegram the final
   *  message carries native Confirm/Cancel buttons bound to `pendingId` — the tap
   *  (not the model) applies it, so this channel gets a real confirm boundary.
   *  `impact` (a risk warning) and `body` (the full text being approved, e.g. a
   *  SKILL.md) travel too, so the Telegram user sees exactly what the web card
   *  shows — nobody approves a change blind on any channel. */
  confirm?: { pendingId: string; title: string; before: string; after: string; impact?: string; body?: string; items?: string[] };
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
 *  stays out of the live view; the finished reply still folds all the reasoning
 *  into a collapsed <details> (see `composeFinal`). Markdown isn't parsed inside
 *  <tg-thinking> (only HTML tags are), so the reasoning is HTML-escaped. */
export function composeDraft(answer: string, reasoning: string, status: StreamStatus, t: Translator): DraftBody {
  if (answer.trim()) return { markdown: answer };
  const think = reasoning.trim().slice(-THINKING_MAX_CHARS);
  const inner =
    status?.kind === "tool"
      ? `🔧 ${escapeHtml(status.label)}${status.detail ? ` — ${escapeHtml(status.detail)}` : ""}`
      : escapeHtml(think) || t("statusThinking");
  return { html: `<tg-thinking>${inner}</tg-thinking>` };
}

/** Final view, mirroring the web: the model's thinking is folded into a
 *  collapsed `<details>` block above the answer, summarized by the tool-count log
 *  ("✅ N tools · Ts") when tools ran, or a plain "Reasoning" label otherwise.
 *  Bot API 10.1 rich Markdown renders the `<details>` body as Markdown, so the
 *  reasoning stays formatted and the answer below is sent verbatim — we only
 *  HTML-escape the angle brackets that would otherwise be read as tags. With no
 *  reasoning we keep the lighter one-line blockquote log (or nothing). `doneLog`
 *  is an ICU plural string, so the tool-count grammar is correct in every locale. */
export function composeFinal(
  body: string,
  reasoning: string,
  toolCount: number,
  elapsedMs: number,
  t: Translator,
  reasoningMs?: number,
): string {
  const log = toolCount > 0 ? t("doneLog", { count: toolCount, secs: Math.round(elapsedMs / 1000) }) : null;
  const think = reasoning.trim().slice(-THINKING_MAX_CHARS);
  if (think) {
    // Grok-style summary: "💭 Reasoned for 58s" — the reasoning phase, not the
    // whole turn (which would over-count the answer streaming time).
    const summary = escapeHtml(t("reasonedFor", { duration: formatShortDuration(reasoningMs ?? elapsedMs) }));
    const block = `<details><summary>${summary}</summary>\n\n${escapeHtml(think)}\n\n</details>`;
    return body ? `${block}\n\n${body}` : block;
  }
  if (log) return body ? `> ${log}\n\n${body}` : `> ${log}`;
  return body;
}

/** The confirm preview shown before a staged change is approved — the same
 *  consent contract on every channel. Everything the user must SEE to approve
 *  safely (the before→after diff, the ⚠️ impact warning, a skill's full body) is
 *  rendered into BOTH the rich markdown and the plain-text fallback, so a Markdown
 *  rejection can never silently strip the impact line or the body the web card shows. */
export function composeConfirmPreview(
  c: { title: string; before: string; after: string; impact?: string; body?: string; items?: string[] },
  t: Translator,
): { markdown: string; plain: string } {
  const diff = c.before && c.before !== c.after ? `${c.before} → ${c.after}` : c.after;
  // Title + ⚠️ impact are consecutive blockquote lines → one quote block in rich md.
  const quote = [`> ${escapeHtml(c.title)}${diff ? `: ${escapeHtml(diff)}` : ""}`];
  const plain = [`${c.title}${diff ? `: ${diff}` : ""}`];
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

  constructor(private readonly chatId: number, locale?: string) {
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
      const draft = composeDraft(answer, reasoning, status, this.t);
      await bot.api.sendRichMessageDraft(this.chatId, this.draftId, draft);
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
        await bot.api.sendRichMessageDraft(this.chatId, this.draftId, this.lastDraft);
        this.lastSentAt = Date.now();
      }
    } catch (e) {
      log.warn("telegram draft keepalive failed", { chatId: this.chatId, err: String(e) });
    } finally {
      this.scheduleKeepalive(); // no-op once closed (guarded above)
    }
  }

  // Send one rich message, falling back to plain-text chunks if the Markdown is
  // rejected (so a formatting quirk never drops the message). `plain` is the
  // markup-free text for that fallback; `silent` suppresses the notification.
  private async sendRich(markdown: string, plain: string, silent: boolean, keyboard?: InlineKeyboard): Promise<void> {
    const bot = await this.getBot();
    if (!bot) return;
    const other = silent || keyboard
      ? { ...(silent ? { disable_notification: true } : {}), ...(keyboard ? { reply_markup: keyboard } : {}) }
      : undefined;
    try {
      await bot.api.sendRichMessage(this.chatId, { markdown }, other);
    } catch (e) {
      log.warn("telegram rich send failed; falling back to plain", { chatId: this.chatId, err: String(e) });
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
    if (result.status === "cancelled") return; // nothing useful to persist

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
    const reasoning = result.reasoning ?? "";
    let markdown: string | null;
    if (body) {
      // The whole answer, one message — capped with the tool log + collapsed
      // reasoning (the <tg-thinking> the draft showed, folded into <details>).
      markdown = composeFinal(body, reasoning, result.toolCount, result.elapsedMs, this.t, result.reasoningMs);
    } else if (result.toolCount > 0 || reasoning.trim()) {
      // Tools ran / it thought but wrote no closing text — still cap the reply
      // with a "done" footer so it doesn't just trail off.
      markdown = composeFinal("", reasoning, result.toolCount, result.elapsedMs, this.t, result.reasoningMs);
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

    // A staged confirmation: append a compact before→after preview and native
    // Confirm/Cancel buttons. The tap (bound to this Telegram user) applies it —
    // the model can't, so Telegram gets the same real confirm boundary as web.
    if (result.confirm) {
      const c = result.confirm;
      const { markdown: previewMd, plain: previewPlain } = composeConfirmPreview(c, this.t);
      markdown = markdown ? `${markdown}\n\n${previewMd}` : previewMd;
      // The plain-text fallback carries the SAME preview (diff + impact + body), so
      // a Markdown rejection never drops what the user needs to approve safely.
      const plain = body ? `${body}\n\n${previewPlain}` : previewPlain;
      const keyboard = new InlineKeyboard()
        .text(this.t("confirmApply"), `mc:${c.pendingId}`)
        .text(this.t("confirmCancel"), `mx:${c.pendingId}`);
      await this.sendRich(markdown, plain, false, keyboard);
      return;
    }

    if (markdown) await this.sendRich(markdown, notice ? `${notice}\n\n${body}` : body || this.t("noText"), false);
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
