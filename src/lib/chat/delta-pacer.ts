/**
 * The client's jitter buffer for streamed text. The runner publishes deltas in
 * ~100ms batches (~10/s); shown as they land, a paragraph grows in slabs of
 * twenty-odd tokens, and the eye reads that as stutter rather than typing. The
 * pacer takes the batches as they come and releases them at a steady, readable
 * cadence — whole words, every tick — so the network's rhythm never reaches the
 * screen. Speed adapts to the model: it tracks the incoming rate and adds a
 * catch-up term for the backlog, so a fast model is never far behind and a slow
 * one is never shown in a spurt followed by silence (the shape of Convex Agent's
 * `useSmoothText`, whose numbers converge with beautifului's 55ms/word).
 *
 * Each render of the streaming message costs O(its full length) (Streamdown
 * re-parses), and 20 renders/s on a long reply is what once froze phones. So the
 * tick lengthens as the message grows: fast while it reads as typing, coarser
 * once it is a wall of text nobody follows word by word.
 *
 * Only order-insensitive-dense events (text/reasoning deltas) are enqueued;
 * everything else goes through `flush()` first so the part order is preserved.
 */
export type PacedDelta = { delta: string; messageId?: string };

const INITIAL_CPS = 128;       // reading pace before the model's own rate is known
const MIN_CPS = 40;            // floor so a stalled estimate never freezes the tail
const CATCH_UP_MS = 400;       // backlog is drained within about this long
const MAX_WORD_EXTEND = 24;    // finish the word at the cut, unless it's not a word (CJK, base64)
const TICK_MIN_MS = 50;        // 20 fps while the message is short
const TICK_MAX_MS = 250;       // the old coalescer's cadence, once it is long
const SHORT_CHARS = 4_000;     // tick stays at the minimum up to here…
const LONG_CHARS = 20_000;     // …and reaches the maximum here

// Two deltas belong to the same part when everything but the text matches
// (type, ids); `seq` is excluded — it is per publish, and the cursor already
// advanced at receive time.
const sameKind = (a: PacedDelta, b: PacedDelta) => {
  const ka = Object.keys(a).filter((k) => k !== "delta" && k !== "seq");
  const kb = Object.keys(b).filter((k) => k !== "delta" && k !== "seq");
  return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
};

export function createDeltaPacer<E extends PacedDelta>(apply: (event: E) => void) {
  let queue: E[] = [];
  let backlog = 0;
  let shown = 0;                 // chars released for the current message (drives the tick)
  let lastMessageId: string | undefined;
  let incoming = INITIAL_CPS / 1000;   // EMA of the model's rate, chars/ms
  let speed = INITIAL_CPS / 1000;      // current display rate, chars/ms
  let lastArrivalAt: number | null = null;
  let lastTickAt = 0;
  let held = false;              // the queue holds only a word stub waiting for its tail
  let runSinceWs = 0;            // chars shown since the last whitespace (is the stub a word?)
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tickMs = () => {
    const t = Math.min(1, Math.max(0, (shown - SHORT_CHARS) / (LONG_CHARS - SHORT_CHARS)));
    return TICK_MIN_MS + t * (TICK_MAX_MS - TICK_MIN_MS);
  };

  const note = (part: string) => {
    backlog -= part.length;
    shown += part.length;
    const ws = part.search(/\s\S*$/);
    runSinceWs = ws >= 0 ? part.length - ws - 1 : runSinceWs + part.length;
  };

  const release = (chars: number) => {
    let budget = chars;
    while (queue.length && budget > 0) {
      const head = queue[0];
      // What may be shown now. Server batches cut at token boundaries, so when
      // this is the last thing in the queue and it ends mid-word, the rest of
      // that word is still in flight: hold the stub for the next delta (or the
      // flush). A run longer than any word (CJK, base64) is not a stub.
      let avail = head.delta;
      if (queue.length === 1) {
        const stub = /\S+$/.exec(avail);
        const runLen = stub ? stub[0].length + (stub.index === 0 ? runSinceWs : 0) : 0;
        if (stub && runLen < MAX_WORD_EXTEND) avail = avail.slice(0, stub.index);
      }
      if (!avail) {
        held = true;
        return;
      }
      if (avail.length <= budget) {
        budget -= avail.length;
        note(avail);
        if (avail.length === head.delta.length) {
          queue.shift();
          apply(head);
          continue;
        }
        queue[0] = { ...head, delta: head.delta.slice(avail.length) };
        held = true;
        apply({ ...head, delta: avail });
        return;
      }
      // Split at the budget, extended to the end of the word it lands in.
      let cut = budget;
      const ws = avail.slice(cut, cut + MAX_WORD_EXTEND).search(/\s/);
      if (ws >= 0) cut += ws + 1;
      // Never split a surrogate pair (emoji) across two ticks.
      if (cut < avail.length && /[\uD800-\uDBFF]/.test(avail[cut - 1])) cut++;
      const part = avail.slice(0, cut);
      queue[0] = { ...head, delta: head.delta.slice(cut) };
      note(part);
      budget = 0;
      apply({ ...head, delta: part });
    }
  };

  const tick = () => {
    timer = null;
    const now = Date.now();
    const elapsed = Math.max(1, now - lastTickAt);
    lastTickAt = now;
    // Target = what the model produces + whatever it takes to drain the backlog
    // soon; smoothed 2:1 toward the target and never more than doubled in one
    // tick, so the cadence changes without a visible lurch.
    const target = incoming + backlog / CATCH_UP_MS;
    speed = Math.min((2 * target + speed) / 3, speed * 2);
    speed = Math.max(speed, MIN_CPS / 1000);
    release(Math.max(1, Math.floor(speed * elapsed)));
    // A held stub (see release) waits for its continuation, not for a tick.
    if (queue.length && !held) timer = setTimeout(tick, tickMs());
  };

  return {
    enqueue(event: E) {
      const now = Date.now();
      if (event.messageId !== lastMessageId) {
        lastMessageId = event.messageId;
        shown = 0;
      }
      // Measure the model's rate from arrival to arrival; a long gap (a tool
      // call, a thought) is a pause, not a slower model, so it is not counted.
      if (lastArrivalAt !== null) {
        const dt = now - lastArrivalAt;
        if (dt > 0 && dt < 2000) incoming = (2 * (event.delta.length / dt) + incoming) / 3;
      }
      lastArrivalAt = now;
      held = false;
      // Consecutive deltas of one part are one text: merge them so word
      // boundaries are found across the seam between two server batches (a
      // slow model's batches cut words anywhere) and a tick applies one event.
      const tail = queue[queue.length - 1];
      if (tail && tail.messageId === event.messageId && sameKind(tail, event)) {
        queue[queue.length - 1] = { ...tail, delta: tail.delta + event.delta };
      } else {
        queue.push(event);
      }
      backlog += event.delta.length;
      if (!timer) {
        lastTickAt = now;
        timer = setTimeout(tick, tickMs());
      }
    },
    /** Apply the whole backlog now (an order-sensitive event follows, or the turn ended). */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      held = false;
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      backlog = 0;
      for (const e of batch) {
        note(e.delta);
        apply(e);
      }
    },
    /** Drop anything buffered without applying (unmount/chat switch). */
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      held = false;
      queue = [];
      backlog = 0;
    },
  };
}
