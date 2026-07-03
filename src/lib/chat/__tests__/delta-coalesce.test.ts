import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeltaCoalescer } from "../delta-coalesce";

describe("createDeltaCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds enqueued events until the interval elapses, then applies them in order", () => {
    const applied: string[] = [];
    const c = createDeltaCoalescer((e: string) => applied.push(e), 250);

    c.enqueue("a");
    c.enqueue("b");
    c.enqueue("c");
    expect(applied).toEqual([]); // нічого не застосовано до спливу інтервалу

    vi.advanceTimersByTime(250);
    expect(applied).toEqual(["a", "b", "c"]);
  });

  it("flush() applies buffered events immediately and cancels the pending timer", () => {
    const applied: string[] = [];
    const c = createDeltaCoalescer((e: string) => applied.push(e), 250);

    c.enqueue("a");
    c.flush();
    expect(applied).toEqual(["a"]);

    // Таймер скасовано — повторне спрацювання не дублює події.
    vi.advanceTimersByTime(500);
    expect(applied).toEqual(["a"]);
  });

  it("flush() on an empty buffer is a no-op", () => {
    const applied: string[] = [];
    const c = createDeltaCoalescer((e: string) => applied.push(e), 250);
    c.flush();
    expect(applied).toEqual([]);
  });

  it("re-arms the timer for events enqueued after a flush", () => {
    const applied: string[] = [];
    const c = createDeltaCoalescer((e: string) => applied.push(e), 250);

    c.enqueue("a");
    vi.advanceTimersByTime(250);
    c.enqueue("b");
    expect(applied).toEqual(["a"]);
    vi.advanceTimersByTime(250);
    expect(applied).toEqual(["a", "b"]);
  });

  it("dispose() drops buffered events without applying them", () => {
    const applied: string[] = [];
    const c = createDeltaCoalescer((e: string) => applied.push(e), 250);

    c.enqueue("a");
    c.dispose();
    vi.advanceTimersByTime(500);
    expect(applied).toEqual([]);
  });
});
