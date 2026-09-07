/**
 * Burst grouping for consecutive Telegram messages.
 *
 * People type one thought per message — "check this file", two seconds later
 * "and compare it with last month", then a screenshot. With one update per turn
 * the agent answers the first fragment alone and the rest fold into a single
 * follow-up turn behind it, so it answers a question nobody finished asking.
 * This collector holds pieces per SENDER per Telegram chat and hands the caller
 * ONE turn covering the whole burst. Per sender, not per chat: in a group two
 * linked people can be typing at once, and merging their pieces would attribute
 * one person's text and files to the other's Capka account.
 *
 * Deliberately generic over the context/file types: no grammY here, so the
 * window and cap decisions are unit-testable with fake timers.
 *
 * In-memory by design, but not lossy on a planned shutdown: `drainAll()` flushes
 * every open burst, and the bot calls it after it stops polling. Only a crash
 * (or a kill -9) drops un-flushed text — nothing was enqueued, charged, or saved
 * yet, so the user just retypes.
 */

/** Silence that closes a burst. Long enough to catch the follow-up thought
 *  someone is already typing, short enough that a lone message doesn't read as
 *  a hung bot (the caller shows a typing action immediately to cover it). */
export const BURST_QUIET_MS = 2500;
/** Ceiling measured from the first piece, so a chat that never falls quiet —
 *  someone narrating a task line by line — still gets an answer. */
export const BURST_MAX_MS = 12_000;
/** A rapid-fire dump must not slide the quiet window forever; close at once. */
export const BURST_MAX_PIECES = 20;
/** The same guard by size: 100 KB of text is already far past a prompt. */
export const BURST_MAX_TEXT_BYTES = 100 * 1024;

/** One incoming update's contribution: its text (a file caption counts) and any
 *  files it carried. */
export type BurstPiece<C, F> = { ctx: C; text: string; files: F[] };
/** What one closed burst becomes: exactly one turn's worth of input. */
export type BurstBatch<C, F> = { ctx: C; text: string; files: F[] };

/** Join the pieces in arrival order. Blank pieces (an uncaptioned photo) are
 *  dropped so they don't open the text with empty paragraphs. */
export function joinBurstText(texts: string[]): string {
  return texts.filter((t) => t.trim().length > 0).join("\n\n");
}

type Entry<C, F> = {
  /** The chat this burst belongs to, so a flush keyed by sender can still tell
   *  the caller WHERE the batch goes. */
  chatId: number;
  /** The LAST piece's context — see the comment in `close()`. */
  ctx: C;
  texts: string[];
  files: F[];
  bytes: number;
  pieces: number;
  /** Sliding: re-armed by every piece. */
  quiet: ReturnType<typeof setTimeout>;
  /** Armed once, on the first piece: the hard ceiling. */
  hard: ReturnType<typeof setTimeout>;
};

export type BurstCollector<C, F> = {
  /** Buffer one piece, arming or sliding this SENDER's window in this chat. */
  add(chatId: number, senderId: number, piece: BurstPiece<C, F>): void;
  /** Close this sender's burst in this chat NOW and await its flush; a no-op
   *  when nothing is buffered. Used before an action that would change where the
   *  buffered text belongs (`/new` re-pins the sender's active chat — which is
   *  also why it drains only that sender, never a co-member's burst). */
  drain(chatId: number, senderId: number): Promise<void>;
  /** Close and flush EVERY open burst, awaiting them all. For shutdown: the
   *  pieces exist only here, so returning without this loses the user's
   *  messages with no task and no error to show for them. */
  drainAll(): Promise<void>;
};

export function createBurstCollector<C, F>(
  onFlush: (chatId: number, batch: BurstBatch<C, F>) => void | Promise<void>,
): BurstCollector<C, F> {
  // Bound: one entry per (chat, sender) with an OPEN burst. Every exit path
  // (quiet window, hard ceiling, either cap, drain, drainAll) goes through
  // `close()`, which deletes the entry — so the map only ever holds senders
  // mid-burst.
  const open = new Map<string, Entry<C, F>>();
  const keyOf = (chatId: number, senderId: number) => `${chatId}:${senderId}`;

  function close(key: string): { chatId: number; batch: BurstBatch<C, F> } | null {
    const e = open.get(key);
    if (!e) return null;
    open.delete(key);
    clearTimeout(e.quiet);
    clearTimeout(e.hard);
    // The LAST piece's context, deliberately: `ingest` stores
    // `ctx.message.message_id` as the user row's `telegramMessageId` and sends
    // its refusals (budget, startError) through this ctx. Nothing reads that
    // column today — the delivery sink addresses the CHAT, not a message — so
    // pick for the first reader that would: an answer arriving after the whole
    // burst belongs under its closing message, and the highest id also reads as
    // a watermark for "everything up to here has been ingested".
    return { chatId: e.chatId, batch: { ctx: e.ctx, text: joinBurstText(e.texts), files: e.files } };
  }

  function fire(key: string): Promise<void> {
    const closed = close(key);
    if (!closed) return Promise.resolve();
    return Promise.resolve(onFlush(closed.chatId, closed.batch));
  }

  /** Timer-driven flush: no caller is awaiting it, so a rejection must not
   *  escape as unhandled. The callback owns its own reporting. */
  function fireDetached(key: string): void {
    void fire(key).catch(() => {});
  }

  return {
    add(chatId, senderId, piece) {
      const key = keyOf(chatId, senderId);
      const existing = open.get(key);
      const e: Entry<C, F> =
        existing ??
        {
          chatId,
          ctx: piece.ctx,
          texts: [],
          files: [],
          bytes: 0,
          pieces: 0,
          quiet: setTimeout(() => fireDetached(key), BURST_QUIET_MS),
          hard: setTimeout(() => fireDetached(key), BURST_MAX_MS),
        };
      if (!existing) open.set(key, e);
      e.ctx = piece.ctx;
      e.texts.push(piece.text);
      e.files.push(...piece.files);
      e.bytes += Buffer.byteLength(piece.text, "utf8");
      e.pieces += 1;
      if (e.pieces >= BURST_MAX_PIECES || e.bytes >= BURST_MAX_TEXT_BYTES) {
        fireDetached(key);
        return;
      }
      if (existing) {
        // Sliding window: the newest piece restarts the silence countdown, but
        // never the hard ceiling.
        clearTimeout(e.quiet);
        e.quiet = setTimeout(() => fireDetached(key), BURST_QUIET_MS);
      }
    },
    drain(chatId, senderId) {
      return fire(keyOf(chatId, senderId));
    },
    async drainAll() {
      // Snapshot the keys first: each `fire` deletes its own entry, and the
      // flush callback can buffer again (an ingest failure that re-queues), so
      // iterating the live map would either skip or loop.
      await Promise.all([...open.keys()].map((k) => fire(k)));
    },
  };
}
