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
const CATCH_UP_MS = 400;       // the backlog is brought to HOLD_MS within about this long
// Text kept in hand, measured as how long the model takes to produce it. The
// runner's flushes are not evenly spaced — `doFlush` awaits `saveSnapshot`
// inside the serialized flush chain, so about once a second one interval
// carries a Postgres UPDATE on top of the 100ms timer — and this reserve is
// what covers such a gap instead of passing it to the screen. It costs the
// reader nothing: the first word still leaves on the first tick (the reserve is
// built by running slightly under the model's rate, not by holding text back),
// and the tail is drained by `flush()` when the turn ends.
const HOLD_MS = 300;
const SHORT_TICK_STRETCH = 1.6; // how much slower to tick while the reserve is short
const WORD_BUDGET = 12;         // a tick's budget past which it is already several words
const MAX_WORD_EXTEND = 24;    // finish the word at the cut, unless it's not a word (CJK, base64)
const TICK_MIN_MS = 50;        // 20 fps while the message is short
const TICK_MAX_MS = 250;       // the old coalescer's cadence, once it is long
// Inside an open ``` fence the tick never drops below this. Every render of a
// streaming code block re-tokenizes the whole block for syntax highlighting —
// the one part of a reply whose cost per render grows with the block and is not
// memoized away, and the case where a streaming renderer visibly stalls. Code is
// not read word by word, so releasing it in fewer, larger pieces costs nothing
// legible and cuts the highlighter's work per second by ~3× while it is short.
const CODE_TICK_MS = 150;
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
  let inFence = false;           // the shown text ends inside an open ``` fence
  let fenceTail = "";            // last two shown chars, so a ``` split across parts still counts
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tickMs = () => {
    const t = Math.min(1, Math.max(0, (shown - SHORT_CHARS) / (LONG_CHARS - SHORT_CHARS)));
    const ms = TICK_MIN_MS + t * (TICK_MAX_MS - TICK_MIN_MS);
    const base = inFence ? Math.max(ms, CODE_TICK_MS) : ms;
    // Short of the reserve: space the ticks out. Lowering `speed` cannot do it —
    // the release quantum is a whole word, and at an ordinary model's rate one
    // word per minimum tick already IS its full rate, so the reserve could never
    // build however low the target went. Spacing is the only lever left, and it
    // is a gentle one: 1.6× at the floor is 80ms, still finer than the 100ms
    // stream being smoothed.
    //
    // Only where a tick's budget is about a word, though. A fast model already
    // affords several per tick, so spacing them buys nothing there — those gaps
    // are even with no reserve at all — while each release becomes a bigger
    // clump, which is the thing this whole module exists to avoid.
    const short = backlog < incoming * HOLD_MS && speed * base < WORD_BUDGET;
    return short ? base * SHORT_TICK_STRETCH : base;
  };

  const note = (part: string) => {
    backlog -= part.length;
    shown += part.length;
    const ws = part.search(/\s\S*$/);
    runSinceWs = ws >= 0 ? part.length - ws - 1 : runSinceWs + part.length;
    // Every ``` toggles the fence. Counted over the previous two chars plus this
    // part: a marker cannot fit inside two chars, so nothing is counted twice, and
    // one that straddles the seam is still seen. The odd cases (a four-backtick
    // fence, ``` inside inline code) cost a coarser or finer tick, nothing worse.
    const marks = (fenceTail + part).match(/```/g);
    if (marks && marks.length % 2) inFence = !inFence;
    fenceTail = (fenceTail + part).slice(-2);
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
      // Split on the last word boundary the budget reaches — the most whole
      // words it affords, never one more. Extending FORWARD to the end of the
      // word the cut lands in (what this did) overshoots by up to a word, and a
      // batch at the size a real model produces is barely longer than one
      // tick's budget: the overshoot then swallows the whole batch and the pacer
      // turns transparent, replaying the server's cadence instead of its own.
      // Falling back to the forward extend matters for the case that has no
      // boundary to go back to — the budget landing inside the first word.
      let cut = budget;
      const whole = /[\s\S]*\s/.exec(avail.slice(0, cut));
      if (whole) cut = whole[0].length;
      else {
        const ws = avail.slice(cut, cut + MAX_WORD_EXTEND).search(/\s/);
        if (ws >= 0) cut += ws + 1;
      }
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
    // Target = what the model produces, plus whatever brings the backlog to the
    // buffer we mean to keep — draining what exceeds it, and running under the
    // model's rate while it is missing (the term goes negative on its own, so
    // there is no second branch). Draining to EMPTY, which this did, is what
    // left nothing in hand: a buffer with no reserve can only smooth within one
    // batch, so a longer pause upstream reached the screen at full length.
    // Smoothed 2:1 toward the target and never more than doubled in one tick, so
    // the cadence changes without a visible lurch.
    const target = incoming + (backlog - incoming * HOLD_MS) / CATCH_UP_MS;
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
        inFence = false;
        fenceTail = "";
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
