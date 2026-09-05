import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The point of the module is that two consumers cost one connection, so the
 * things worth asserting are all about arithmetic on that count — not about
 * events, which are a pass-through.
 */

type Handler = ((e: unknown) => void) | null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  closed = false;
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.({});
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

vi.stubGlobal("EventSource", FakeEventSource);

let subscribeEvents: typeof import("../event-stream").subscribeEvents;

beforeEach(async () => {
  FakeEventSource.instances = [];
  vi.resetModules();
  ({ subscribeEvents } = await import("../event-stream"));
});

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

describe("subscribeEvents", () => {
  it("opens one connection for two listeners and closes it with the last", () => {
    const a = subscribeEvents({ onMessage: () => {} });
    const b = subscribeEvents({ onMessage: () => {} });
    expect(FakeEventSource.instances).toHaveLength(1);

    a();
    expect(latest().closed).toBe(false);
    b();
    expect(latest().closed).toBe(true);
  });

  it("delivers each parsed event to every listener", () => {
    const seen: unknown[] = [];
    subscribeEvents({ onMessage: (d) => seen.push(d) });
    subscribeEvents({ onMessage: (d) => seen.push(d) });
    latest().emit({ type: "task:finish", chatId: "c1" });
    expect(seen).toEqual([
      { type: "task:finish", chatId: "c1" },
      { type: "task:finish", chatId: "c1" },
    ]);
  });

  it("tells a late listener the stream is already open", () => {
    // Without this the chat panel reads a healthy stream as a dead one and falls
    // back to polling every three seconds for the whole turn.
    subscribeEvents({ onMessage: () => {} });
    latest().open();
    const onOpen = vi.fn();
    subscribeEvents({ onMessage: () => {}, onOpen });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("retries once for everyone, and not at all once nobody is listening", () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const stop = subscribeEvents({ onMessage: () => {}, onError });
      subscribeEvents({ onMessage: () => {} });
      latest().fail();
      expect(onError).toHaveBeenCalledTimes(1);

      // A second subscriber arriving mid-backoff must join the pending retry, not
      // race it with a connection of its own.
      subscribeEvents({ onMessage: () => {} });
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(FakeEventSource.instances).toHaveLength(2);

      stop();
      latest().fail();
      vi.advanceTimersByTime(60_000);
      // Two listeners remain, so exactly one reconnect — not one per listener.
      expect(FakeEventSource.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
