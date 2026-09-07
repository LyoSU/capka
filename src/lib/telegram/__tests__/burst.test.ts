import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createBurstCollector,
  BURST_QUIET_MS,
  BURST_MAX_MS,
  BURST_MAX_PIECES,
  BURST_MAX_TEXT_BYTES,
  type BurstBatch,
} from "../burst";

// The collector is generic over the grammY types on purpose, so a piece here is
// just a labelled context plus fake files.
type Ctx = { id: number };
type Fl = { name: string };

const CHAT = 42;
const SENDER = 1001;
const OTHER_SENDER = 2002;

function harness() {
  const flushed: BurstBatch<Ctx, Fl>[] = [];
  const onFlush = vi.fn((_chatId: number, batch: BurstBatch<Ctx, Fl>) => {
    flushed.push(batch);
  });
  return { flushed, onFlush, c: createBurstCollector<Ctx, Fl>(onFlush) };
}

const piece = (id: number, text: string, files: Fl[] = []) => ({ ctx: { id }, text, files });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("telegram burst collector", () => {
  it("flushes a lone message only after the quiet window", () => {
    const { flushed, c } = harness();
    c.add(CHAT, SENDER, piece(1, "hello"));
    vi.advanceTimersByTime(BURST_QUIET_MS - 1);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([{ ctx: { id: 1 }, text: "hello", files: [] }]);
  });

  it("groups messages inside the sliding window into ONE flush, joined in arrival order", () => {
    const { flushed, onFlush, c } = harness();
    c.add(CHAT, SENDER, piece(1, "check this file", [{ name: "a.csv" }]));
    vi.advanceTimersByTime(BURST_QUIET_MS - 500);
    c.add(CHAT, SENDER, piece(2, "and compare with last month"));
    vi.advanceTimersByTime(BURST_QUIET_MS - 500);
    // An uncaptioned photo contributes a file and no text.
    c.add(CHAT, SENDER, piece(3, "", [{ name: "shot.jpg" }]));
    vi.advanceTimersByTime(BURST_QUIET_MS);

    expect(onFlush).toHaveBeenCalledOnce();
    expect(flushed[0]).toEqual({
      // The LAST piece's context: the answer belongs under the closing message.
      ctx: { id: 3 },
      text: "check this file\n\nand compare with last month",
      files: [{ name: "a.csv" }, { name: "shot.jpg" }],
    });
  });

  it("keeps separate chats apart", () => {
    const { flushed, c } = harness();
    c.add(CHAT, SENDER, piece(1, "mine"));
    c.add(99, SENDER, piece(2, "theirs"));
    vi.advanceTimersByTime(BURST_QUIET_MS);
    expect(flushed.map((b) => b.text)).toEqual(["mine", "theirs"]);
  });

  it("closes at the hard ceiling even while messages keep arriving", () => {
    const { flushed, c } = harness();
    // Never quiet: a piece every (quiet - 100) ms would slide the window forever.
    for (let elapsed = 0; elapsed < BURST_MAX_MS + BURST_QUIET_MS; elapsed += BURST_QUIET_MS - 100) {
      c.add(CHAT, SENDER, piece(1, "x"));
      vi.advanceTimersByTime(BURST_QUIET_MS - 100);
      if (elapsed + BURST_QUIET_MS - 100 < BURST_MAX_MS) expect(flushed).toHaveLength(0);
    }
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    // The ceiling flush carries everything typed up to it, and the pieces that
    // arrived after it start a fresh burst rather than being dropped.
    expect(flushed[0].text.split("\n\n").length).toBeGreaterThan(1);
  });

  it("closes immediately at the piece cap, without waiting for silence", () => {
    const { flushed, c } = harness();
    for (let i = 0; i < BURST_MAX_PIECES; i++) c.add(CHAT, SENDER, piece(i, `m${i}`));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].text.split("\n\n")).toHaveLength(BURST_MAX_PIECES);
    // Timers from the closed burst are cancelled — no phantom second flush.
    vi.advanceTimersByTime(BURST_MAX_MS);
    expect(flushed).toHaveLength(1);
  });

  it("closes immediately at the text-size cap", () => {
    const { flushed, c } = harness();
    const half = "a".repeat(BURST_MAX_TEXT_BYTES / 2);
    c.add(CHAT, SENDER, piece(1, half));
    expect(flushed).toHaveLength(0);
    c.add(CHAT, SENDER, piece(2, half));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].text).toHaveLength(BURST_MAX_TEXT_BYTES + 2); // both halves + "\n\n"
  });

  it("drain flushes what is buffered right away and leaves nothing armed (the /new path)", async () => {
    const { flushed, c } = harness();
    c.add(CHAT, SENDER, piece(1, "half a thought"));
    await c.drain(CHAT, SENDER);
    expect(flushed).toEqual([{ ctx: { id: 1 }, text: "half a thought", files: [] }]);
    vi.advanceTimersByTime(BURST_MAX_MS);
    expect(flushed).toHaveLength(1);
  });

  it("drain awaits the flush, so the caller can act after the turn is enqueued", async () => {
    const order: string[] = [];
    const c = createBurstCollector<Ctx, Fl>(async () => {
      await Promise.resolve();
      order.push("ingested");
    });
    c.add(CHAT, SENDER, piece(1, "text"));
    await c.drain(CHAT, SENDER);
    order.push("after drain");
    expect(order).toEqual(["ingested", "after drain"]);
  });

  it("drain on a chat with nothing buffered is a no-op", async () => {
    const { onFlush, c } = harness();
    await c.drain(CHAT, SENDER);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("never merges two senders in the same group chat", async () => {
    const { flushed, onFlush, c } = harness();
    // Alice and Bob are both linked and both typing in one group inside a single
    // burst window. Their pieces must stay two turns owned by two accounts —
    // merging them attributes Bob's text and files to Alice's Capka account (and
    // vice versa), which is a cross-account disclosure, not a formatting nit.
    c.add(CHAT, SENDER, piece(1, "alice: my payroll file", [{ name: "payroll.xlsx" }]));
    c.add(CHAT, OTHER_SENDER, piece(2, "bob: unrelated question"));
    vi.advanceTimersByTime(BURST_QUIET_MS);

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(flushed).toEqual([
      { ctx: { id: 1 }, text: "alice: my payroll file", files: [{ name: "payroll.xlsx" }] },
      { ctx: { id: 2 }, text: "bob: unrelated question", files: [] },
    ]);
    // Both flushes still address the chat they came from.
    expect(onFlush.mock.calls.map((c2) => c2[0])).toEqual([CHAT, CHAT]);
  });

  it("a sender's cap does not close a co-member's burst, and drain touches only the sender asked for", async () => {
    const { flushed, c } = harness();
    c.add(CHAT, OTHER_SENDER, piece(9, "still typing"));
    for (let i = 0; i < BURST_MAX_PIECES; i++) c.add(CHAT, SENDER, piece(i, `m${i}`));
    // The piece cap closed SENDER's burst only.
    expect(flushed).toHaveLength(1);
    expect(flushed[0].ctx).toEqual({ id: 19 });

    // /new from SENDER must not send a co-member's half-typed thought.
    await c.drain(CHAT, SENDER);
    expect(flushed).toHaveLength(1);
    await c.drain(CHAT, OTHER_SENDER);
    expect(flushed.map((b) => b.text)).toEqual([flushed[0].text, "still typing"]);
  });

  it("drainAll flushes every open burst across chats and senders (the shutdown path)", async () => {
    const { flushed, onFlush, c } = harness();
    c.add(CHAT, SENDER, piece(1, "a"));
    c.add(CHAT, OTHER_SENDER, piece(2, "b"));
    c.add(99, SENDER, piece(3, "c"));

    await c.drainAll();

    expect(onFlush).toHaveBeenCalledTimes(3);
    expect(flushed.map((b) => b.text).sort()).toEqual(["a", "b", "c"]);
    expect(onFlush.mock.calls.map((c2) => c2[0]).sort()).toEqual([42, 42, 99]);
    // Nothing armed afterwards: a restart cannot double-deliver what it drained.
    vi.advanceTimersByTime(BURST_MAX_MS);
    expect(flushed).toHaveLength(3);
  });

  it("drainAll awaits every flush before returning, and is a no-op with nothing buffered", async () => {
    const order: string[] = [];
    const c = createBurstCollector<Ctx, Fl>(async (_chatId, batch) => {
      await Promise.resolve();
      order.push(batch.text);
    });
    c.add(CHAT, SENDER, piece(1, "one"));
    c.add(CHAT, OTHER_SENDER, piece(2, "two"));
    await c.drainAll();
    order.push("stopped");
    expect(order).toEqual(["one", "two", "stopped"]);

    await c.drainAll(); // empty now — must not throw or flush again
    expect(order).toEqual(["one", "two", "stopped"]);
  });
});
