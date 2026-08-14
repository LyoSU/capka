import { planGapDrain } from "./stream-reconcile";

/**
 * Recovery for a streaming reply that fell behind the live event stream.
 *
 * A missed event (SSE reconnect, a dropped NOTIFY, a payload too big for it)
 * leaves every later event past a gap. Recovery has to do two things, and the
 * first version of it did neither:
 *
 *  1. RUN AT ALL. The reload used to be scheduled on a trailing debounce, and the
 *     events it recovers from arrive every ~100ms — well inside any sane debounce
 *     window — so each gapped delta re-armed the timer and the reload never fired.
 *     One dropped event froze the reply on screen for the rest of the turn while
 *     the agent kept working. So: fire on the LEADING edge, and space retries from
 *     the last reload rather than from the last event.
 *
 *  2. CONVERGE. The snapshot a reload returns is up to a second stale (the runner
 *     persists ~1/s while it publishes ~10/s), so adopting it alone lands the
 *     client straight back in a gap. So: hold the events we can't apply yet and
 *     replay the ones the snapshot doesn't cover.
 *
 * Timer- and clock-injectable so both properties are testable without React.
 */

/**
 * How many held events to keep while a reload is in flight. A healthy reload
 * lands in ~200ms — a couple dozen events at the publish rate — so this is only
 * reached when the reload itself is wedged. At the cap we drop what we hold and
 * let the snapshot alone carry the content back: degraded, but bounded.
 */
export const MAX_GAP_BUFFER = 300;

/** Minimum spacing between reconcile reloads. */
const RECONCILE_MIN_MS = 250;

export function createStreamRecovery<E extends { messageId: string; seq?: number }>({
  reload,
  apply,
  cursors,
  minIntervalMs = RECONCILE_MIN_MS,
  now = Date.now,
}: {
  /** Pull a fresh DB snapshot; must re-seed `cursors` from its streamSeq. */
  reload: () => Promise<void>;
  /** Apply one event. Returns false when it could not be applied (the reply row
   *  isn't in the client's copy yet) — then it stays held instead of vanishing. */
  apply: (event: E) => boolean;
  /** Highest seq applied per message. Read after each reload, advanced on replay. */
  cursors: Map<string, number>;
  minIntervalMs?: number;
  now?: () => number;
}) {
  let buffer: E[] = [];
  let reloading = false;
  let lastReloadAt = -Infinity;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const drain = () => {
    if (buffer.length === 0) return;
    const { apply: replay, keep } = planGapDrain(buffer, cursors);
    buffer = keep;
    for (let i = 0; i < replay.length; i++) {
      const event = replay[i];
      if (!apply(event)) {
        // Put this event and everything after it back, in publish order: replaying
        // the tail over a hole would paint later text onto a reply that is missing
        // an earlier passage.
        buffer = [...replay.slice(i), ...buffer];
        break;
      }
      if (typeof event.seq === "number") cursors.set(event.messageId, event.seq);
    }
    if (buffer.length > 0) reconcile();
  };

  /** Pull a fresh snapshot, then replay whatever it doesn't already cover. */
  const reconcile = () => {
    if (disposed || reloading || retryTimer) return;
    const wait = minIntervalMs - (now() - lastReloadAt);
    if (wait > 0) {
      retryTimer = setTimeout(() => { retryTimer = null; reconcile(); }, wait);
      return;
    }
    reloading = true;
    void reload().finally(() => {
      reloading = false;
      lastReloadAt = now();
      if (!disposed) drain();
    });
  };

  return {
    reconcile,
    /** Hold an event we can't apply yet, and get a reload moving. */
    hold(event: E) {
      if (buffer.length >= MAX_GAP_BUFFER) buffer = [];
      buffer.push(event);
      reconcile();
    },
    /** Forget everything held for a reply. Its turn ended and its cursor is gone,
     *  so a later drain would read "nothing applied yet" and replay those events
     *  onto the finished message, duplicating text the reload already brought back. */
    drop(messageId: string) {
      buffer = buffer.filter((e) => e.messageId !== messageId);
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      buffer = [];
    },
    /** Test/diagnostic view of what's still held. */
    get held() { return buffer.length; },
  };
}
