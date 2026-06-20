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
import { InputFile } from "grammy";
import { log } from "@/lib/log";
import { getTranslator, type Translator } from "@/lib/i18n/translator";

// `locale` carries the originating Telegram client's language so the bot's
// outbound text (status header, collapsed log, error fallbacks) matches what the
// user sees in the chat — falling back to English for anything we don't ship.
export type TaskOrigin = { platform: "telegram"; telegramChatId: number; locale?: string };

export interface TaskResult {
  status: "completed" | "failed" | "cancelled";
  text: string;
  /** Friendly, user-facing error (set when status is "failed"). */
  error?: string;
}

/** The transient activity shown while the answer streams in. `reasoning` carries
 *  the live thinking text so it can fill a native <tg-thinking> block; `label`
 *  is the same human-readable step text the web UI shows ("Running a command…",
 *  "Creating logo.svg…"), with an optional dim `detail` (e.g. the command). */
export type StreamStatus =
  | { kind: "thinking"; reasoning?: string }
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
 * coalesces internally (the runner calls it on every flush, ~10×/s); `finish`
 * persists the final message exactly once; `sendFiles` delivers any files the
 * run produced. The web sink is a no-op — the web UI already receives
 * everything over realtime and browses sandbox files directly.
 */
export interface DeliverySink {
  push(text: string, status: StreamStatus): void;
  finish(result: TaskResult & { toolCount: number; elapsedMs: number }): Promise<void>;
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

/** Streaming view. While the agent is working with nothing written yet, use the
 *  native <tg-thinking> block (HTML, draft-only) — for reasoning it shows the
 *  live thinking text, for a tool it names the tool. Once answer text starts,
 *  switch to Markdown with a small status header above it. */
export function composeDraft(text: string, status: StreamStatus, t: Translator): DraftBody {
  if (!text.trim() && status) {
    const inner =
      status.kind === "thinking"
        ? escapeHtml((status.reasoning ?? "").trim().slice(-THINKING_MAX_CHARS)) || t("statusThinking")
        : `🔧 ${escapeHtml(status.label)}${status.detail ? ` — ${escapeHtml(status.detail)}` : ""}`;
    return { html: `<tg-thinking>${inner}</tg-thinking>` };
  }
  if (!status) return { markdown: text };
  const header = status.kind === "thinking" ? `💭 _${t("statusThinking")}_` : `🔧 ${status.label}`;
  return { markdown: `> ${header}\n\n${text}` };
}

/** Final view: a collapsed one-line log (only when tools ran) above the answer.
 *  `doneLog` is an ICU plural string, so the tool-count grammar is correct in
 *  every locale. */
export function composeFinal(body: string, toolCount: number, elapsedMs: number, t: Translator): string {
  if (toolCount > 0) {
    const line = t("doneLog", { count: toolCount, secs: Math.round(elapsedMs / 1000) });
    return `> ${line}\n\n${body}`;
  }
  return body;
}

class TelegramSink implements DeliverySink {
  private readonly draftId: number;
  private readonly t: Translator;
  private pending: { text: string; status: StreamStatus } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private lastSentAt = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;

  constructor(private readonly chatId: number, locale?: string) {
    this.draftId = draftIdFrom(`tg:${chatId}:${Date.now()}`);
    this.t = getTranslator(locale, "telegram");
  }

  // Dynamic import keeps the Telegram bot out of contexts that never deliver.
  private async getBot() {
    if (this.bot) return this.bot;
    const { getBot } = await import("@/lib/telegram/bot");
    this.bot = await getBot();
    return this.bot;
  }

  push(text: string, status: StreamStatus): void {
    this.pending = { text, status };
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.inflight) return;
    const wait = Math.max(0, MIN_DRAFT_INTERVAL_MS - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (!this.pending) return;
    const { text, status } = this.pending;
    this.pending = null;
    this.inflight = true;
    try {
      const bot = await this.getBot();
      if (!bot) return;
      if (!text.trim() && !status) return; // nothing to show yet
      // Ephemeral animated preview; the real message is sent on finish().
      await bot.api.sendRichMessageDraft(this.chatId, this.draftId, composeDraft(text, status, this.t));
      this.lastSentAt = Date.now();
    } catch (e) {
      // Non-fatal: the persisted finish() is what the user keeps.
      log.warn("telegram draft update failed", { chatId: this.chatId, err: String(e) });
    } finally {
      this.inflight = false;
      if (this.pending) this.schedule();
    }
  }

  async finish(result: TaskResult & { toolCount: number; elapsedMs: number }): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    if (result.status === "cancelled") return; // nothing useful to persist

    const bot = await this.getBot();
    if (!bot) return;

    const body =
      result.status === "completed"
        ? result.text.trim() || `_${this.t("noText")}_`
        : result.error || this.t("genericError");
    const markdown = composeFinal(body, result.toolCount, result.elapsedMs, this.t);

    try {
      await bot.api.sendRichMessage(this.chatId, { markdown });
    } catch (e) {
      // Malformed Markdown is rare but must never drop the message — fall back
      // to plain text in safe chunks.
      log.warn("telegram rich send failed; falling back to plain", { chatId: this.chatId, err: String(e) });
      try {
        for (const part of chunk(body, TELEGRAM_LIMIT)) {
          await bot.api.sendMessage(this.chatId, part);
        }
      } catch (e2) {
        log.error("telegram delivery failed", { chatId: this.chatId, err: String(e2) });
      }
    }
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
