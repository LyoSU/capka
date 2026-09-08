import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeltaPacer } from "../delta-pacer";

/**
 * The pacer is the client's jitter buffer: deltas arrive in ~100ms server
 * batches, the screen shows them at a steady, readable cadence. Nothing here
 * asserts a constant — only the shape of the behaviour: no slabs, no falling
 * behind, order kept, everything eventually shown.
 */
type Ev = { type: "text" | "reasoning"; messageId: string; delta: string };
const text = (delta: string, messageId = "m1"): Ev => ({ type: "text", messageId, delta });

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ") + " ";

describe("createDeltaPacer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not apply a burst as one slab: the first tick shows only part of it", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    p.enqueue(text(words(60)));
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(60);
    const shown = applied.join("");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(words(60).length / 2);
  });

  it("eventually applies everything, in order, as a prefix-preserving sequence", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    const a = words(20);
    const b = words(20);
    p.enqueue(text(a));
    p.enqueue(text(b));
    vi.advanceTimersByTime(10_000);
    expect(applied.join("")).toBe(a + b);
  });

  it("cuts on word boundaries, so a half-typed word never sits on screen", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    p.enqueue(text("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi "));
    vi.advanceTimersByTime(60);
    expect(applied.length).toBeGreaterThan(0);
    for (const chunk of applied) expect(chunk).toMatch(/\s$/);
  });

  it("never applies an empty delta (a word finished at the cut leaves no husk behind)", () => {
    // One 7-char word per 100ms server batch, i.e. a slow model: the word-boundary
    // extension takes the whole word on the first tick, and the next tick must
    // find the queue empty rather than an event with an empty delta — each apply
    // is a full O(n) re-render.
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    for (let i = 0; i < 20; i++) {
      p.enqueue(text("abcdef "));
      vi.advanceTimersByTime(100);
    }
    expect(applied).not.toContain("");
  });

  it("finds word boundaries across server batches that split a word", () => {
    // A slow model's ~100ms batches are 6–10 chars and cut anywhere. Consecutive
    // deltas of one part are one text, so the boundary search must not stop at
    // the seam between two batches.
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    for (const d of ["Пістаціє", "вий смак ", "росте най", "швидше: ", "продажі ", "за місяць "]) {
      p.enqueue(text(d));
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1_000);
    expect(applied.join("")).toBe("Пістацієвий смак росте найшвидше: продажі за місяць ");
    for (const chunk of applied) expect(chunk).toMatch(/\s$/);
  });

  it("holds back a trailing half-word until its continuation arrives", () => {
    // Server batches cut at token boundaries, not word boundaries. When the screen
    // has caught up with the network, the only thing left to show is the head of a
    // word whose tail is still in flight — so it waits for the tail.
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    p.enqueue(text("продажі за міс"));
    vi.advanceTimersByTime(1_000);
    expect(applied.join("")).toBe("продажі за ");
    p.enqueue(text("яць піднялися "));
    vi.advanceTimersByTime(1_000);
    expect(applied.join("")).toBe("продажі за місяць піднялися ");
  });

  it("does not hold a long run with no whitespace (CJK, base64): past a word's length it is shown", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    const run = "這是一個沒有空格的句子，它一直寫下去而沒有任何停頓或空白字元。";
    p.enqueue(text(run));
    vi.advanceTimersByTime(2_000);
    expect(applied.join("")).toBe(run);
    expect(applied.length).toBeGreaterThan(1); // …and still paced, not dumped
  });

  it("keeps a reasoning delta ahead of the text delta that followed it", () => {
    const applied: Ev[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e));
    p.enqueue({ type: "reasoning", messageId: "m1", delta: words(30) });
    p.enqueue(text(words(30)));
    vi.advanceTimersByTime(10_000);
    const firstText = applied.findIndex((e) => e.type === "text");
    const lastReasoning = applied.map((e) => e.type).lastIndexOf("reasoning");
    expect(lastReasoning).toBeLessThan(firstText);
    expect(applied.filter((e) => e.type === "reasoning").map((e) => e.delta).join("")).toBe(words(30));
  });

  it("carries every field of the source event onto each released chunk", () => {
    const applied: Ev[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e));
    p.enqueue(text(words(40), "m7"));
    vi.advanceTimersByTime(10_000);
    expect(applied.length).toBeGreaterThan(1);
    for (const e of applied) expect(e).toMatchObject({ type: "text", messageId: "m7" });
  });

  it("keeps up with a fast model: the screen is never far behind what arrived", () => {
    // 400 chars/s for 5s in 100ms server batches — far above the reading cadence.
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    let sent = "";
    for (let i = 0; i < 50; i++) {
      const chunk = words(6); // ~40 chars
      sent += chunk;
      p.enqueue(text(chunk));
      vi.advanceTimersByTime(100);
    }
    // Mid-stream lag is bounded (well under a second of text at that rate)…
    expect(sent.length - applied.join("").length).toBeLessThan(400);
    // …and the tail drains shortly after the last batch.
    vi.advanceTimersByTime(600);
    expect(applied.join("")).toBe(sent);
  });

  it("does not starve a slow model: something appears on most ticks while text is pending", () => {
    // ~100 chars/s, i.e. one server batch of ~10 chars every 100ms.
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    for (let i = 0; i < 30; i++) {
      p.enqueue(text("abcdefghi "));
      vi.advanceTimersByTime(100);
    }
    // 3s of text; a slab renderer would show it in ≤12 jumps (250ms), a pacer in many more.
    expect(applied.length).toBeGreaterThan(20);
  });

  it("ticks less often once the message is long, so a phone is not re-rendering 20×/s at O(n)", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    // Warm up: a short message ticks fast.
    p.enqueue(text(words(30)));
    vi.advanceTimersByTime(1_000);
    const shortTicks = applied.length;
    // Now push it past the long threshold and measure the tick rate again.
    p.enqueue(text(words(3_000)));
    vi.advanceTimersByTime(20_000);
    applied.length = 0;
    p.enqueue(text(words(200)));
    vi.advanceTimersByTime(1_000);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.length).toBeLessThan(shortTicks);
    expect(applied.length).toBeLessThanOrEqual(5);
  });

  it("ticks less often inside an open code fence, and returns to prose cadence once it closes", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    // Prose cadence, measured over one second of a short message.
    p.enqueue(text(words(200)));
    vi.advanceTimersByTime(1_000);
    const proseTicks = applied.length;
    expect(proseTicks).toBeGreaterThan(10);
    // The fence opens across a server-batch seam ("``" then "`\n"): still counted.
    // Small enough that the whole message stays under the length threshold, so
    // the only thing changing the tick here is the fence.
    applied.length = 0;
    p.enqueue(text("``"));
    p.enqueue(text("`js\n" + Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n"));
    vi.advanceTimersByTime(1_000);
    const codeTicks = applied.length;
    expect(codeTicks).toBeGreaterThan(0);
    expect(codeTicks).toBeLessThan(proseTicks / 2);
    // Drain the code, close the fence, and the tick is back at prose cadence:
    // counted over the first 200ms, because after a fast drain the rate term
    // empties a short paragraph in a handful of ticks and a one-second count
    // would measure catch-up, not cadence.
    vi.advanceTimersByTime(30_000);
    p.enqueue(text("```\n"));
    vi.advanceTimersByTime(1_000);
    applied.length = 0;
    p.enqueue(text(words(100)));
    vi.advanceTimersByTime(200);
    expect(applied.length).toBeGreaterThanOrEqual(3);
  });

  it("flush() applies the whole backlog at once and cancels the tick", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    const a = words(50);
    p.enqueue(text(a));
    p.flush();
    expect(applied.join("")).toBe(a);
    vi.advanceTimersByTime(5_000);
    expect(applied.join("")).toBe(a);
  });

  it("flush() on an empty backlog is a no-op", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    p.flush();
    expect(applied).toEqual([]);
  });

  it("dispose() drops the backlog without applying it", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    p.enqueue(text(words(50)));
    p.dispose();
    vi.advanceTimersByTime(5_000);
    expect(applied).toEqual([]);
  });

  // The property the pacer exists for, and the one every test above misses. They
  // feed either a big burst (words(60)) or 40-char batches, and at those sizes a
  // tick's budget really does split the batch. At the size a typical model
  // actually produces — ~12 chars per 100ms flush — it does not: the budget is
  // ~7 chars and the word-extend in `release` carries the cut to the end of the
  // next word, which is the end of the batch. So the pacer became transparent,
  // applying one server batch per tick, and the cadence on screen was the
  // cadence of Postgres NOTIFY: two words, pause, two words.
  //
  // Note what this means for the test above it: "does not starve a slow model"
  // passes BECAUSE of that transparency (one apply per batch clears its bar), so
  // wanting the queue drained cannot be the whole specification. The pacer needs
  // a cadence of its own, finer than the stream it is smoothing.
  it("releases on its own cadence, not the server's, on a stream of ordinary speed", () => {
    const at: number[] = [];
    const p = createDeltaPacer(() => at.push(Date.now()));
    // ~120 chars/s, the pace of a typical model, in the runner's 100ms batches.
    for (let i = 0; i < 40; i++) {
      p.enqueue(text(words(2)));
      vi.advanceTimersByTime(100);
    }
    // The first few releases run before the incoming rate is known; the cadence
    // claim is about the steady state, not the first frame.
    const gaps = at.slice(1).map((t, i) => t - at[i]).slice(3);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    expect(median).toBeLessThan(100);
  });

  // The other half of the same missing property. Even releasing one word at a
  // time, the pacer only smooths WITHIN a batch: it drains the queue to empty on
  // every batch, so a hiccup upstream reaches the screen at full length. And the
  // runner's flushes are not evenly spaced — `doFlush` awaits `saveSnapshot`
  // inside the serialized flush chain, so about once a second one interval
  // carries a Postgres UPDATE on top of the 100ms timer. A buffer with nothing
  // in hand has nothing to cover that with.
  it("covers a hiccup in the stream: a longer pause between server flushes does not reach the screen", () => {
    const at: number[] = [];
    const p = createDeltaPacer(() => at.push(Date.now()));
    for (let i = 0; i < 40; i++) {
      p.enqueue(text(words(2)));
      vi.advanceTimersByTime(i % 10 === 9 ? 260 : 100);
    }
    const gaps = at.slice(1).map((t, i) => t - at[i]).slice(3);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    expect(Math.max(...gaps)).toBeLessThanOrEqual(median * 2);
  });

  // Building the reserve costs tick spacing, and that price is only worth paying
  // where the budget is about one word. On a fast model a tick already affords
  // several, so spacing them further buys nothing — its gaps are even without a
  // reserve — and makes each release a bigger clump, which is the very thing the
  // pacer is for.
  it("does not slow its frames on a fast model, where a tick already affords several words", () => {
    const applied: string[] = [];
    const p = createDeltaPacer((e: Ev) => applied.push(e.delta));
    // 300 chars/s in 100ms batches, run past the warm-up…
    for (let i = 0; i < 20; i++) {
      p.enqueue(text(words(5)));
      vi.advanceTimersByTime(100);
    }
    // …then count the releases over one second of the steady state.
    applied.length = 0;
    for (let i = 0; i < 10; i++) {
      p.enqueue(text(words(5)));
      vi.advanceTimersByTime(100);
    }
    // 1s at the 50ms floor is 20 releases; anything near 12 means the tick was
    // stretched to 80ms and the words came in larger groups instead.
    expect(applied.length).toBeGreaterThanOrEqual(16);
  });
});
