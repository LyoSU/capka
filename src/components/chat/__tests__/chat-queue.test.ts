import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readQueue, visibleQueue, QUEUE_PREFIX, type QueuedMessage } from "../use-chat-queue";

// Minimal localStorage stand-in — the hook only ever touches get/set/removeItem.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
}

const KEY = QUEUE_PREFIX + "chat-1";

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("readQueue", () => {
  it("returns a STABLE reference while the stored text is unchanged", () => {
    // useSyncExternalStore polls getSnapshot on every render and compares by
    // reference; a fresh array each call would spin React into an infinite loop.
    const items: QueuedMessage[] = [{ id: "a", text: "hi", refs: [] }];
    localStorage.setItem(KEY, JSON.stringify(items));
    const first = readQueue(KEY);
    const second = readQueue(KEY);
    expect(first).toBe(second);
    expect(first).toEqual(items);
  });

  it("returns a NEW reference once the stored text changes", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "a", text: "hi", refs: [] }]));
    const before = readQueue(KEY);
    localStorage.setItem(KEY, JSON.stringify([{ id: "b", text: "bye", refs: [] }]));
    const after = readQueue(KEY);
    expect(after).not.toBe(before);
    expect(after[0].id).toBe("b");
  });

  it("yields a stable empty array when nothing is stored", () => {
    expect(readQueue(KEY)).toBe(readQueue(KEY));
    expect(readQueue(KEY)).toEqual([]);
  });

  it("falls back to empty on malformed JSON instead of throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readQueue(KEY)).toEqual([]);
  });
});

describe("visibleQueue", () => {
  const msg = (id: string): QueuedMessage => ({ id, text: id, refs: [] });

  it("holds the in-flight item, ahead of what is still queued", () => {
    // The drain dequeues an item as it STARTS, so without the hold the ghost
    // disappears for the length of the folder-sync push and the transcript
    // collapses by one bubble, then grows back.
    const out = visibleQueue({
      queued: [msg("b"), msg("c")],
      sending: msg("a"),
      messageIds: new Set(),
    });
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("drops the in-flight item the moment its real bubble exists", () => {
    // sendMessage inserts the optimistic bubble synchronously, BEFORE the POST,
    // reusing the queued id — so holding until send() resolves would render the
    // same message twice for the whole round-trip.
    const out = visibleQueue({
      queued: [msg("b")],
      sending: msg("a"),
      messageIds: new Set(["a"]),
    });
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  it("never draws an item twice when a second tab still sees it queued", () => {
    const out = visibleQueue({
      queued: [msg("a"), msg("b")],
      sending: msg("a"),
      messageIds: new Set(),
    });
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("drops a queued item that already landed (drained by another tab)", () => {
    const out = visibleQueue({
      queued: [msg("a"), msg("b")],
      sending: null,
      messageIds: new Set(["a"]),
    });
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  it("is empty when nothing is queued or in flight", () => {
    expect(visibleQueue({ queued: [], sending: null, messageIds: new Set() })).toEqual([]);
  });
});
