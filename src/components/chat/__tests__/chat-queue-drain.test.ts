import { describe, expect, it } from "vitest";
import { drainQueue, mergeQueue, type QueuedMessage } from "../use-chat-queue";
import type { FileRef } from "@/lib/constants";

const msg = (id: string): QueuedMessage => ({ id, text: id, refs: [] });

describe("mergeQueue", () => {
  it("is the computed queue itself when nothing else wrote", () => {
    const next = [msg("a")];
    // Same reference, not merely equal: the snapshot feeds useSyncExternalStore.
    expect(mergeQueue([msg("a"), msg("b")], [msg("a"), msg("b")], next)).toBe(next);
  });

  // The defect: `setItem` writes the whole array, so the second tab's message was
  // erased by the first tab's next dequeue — and localStorage held the only copy.
  it("keeps a message a second tab enqueued while this tab was dequeuing", () => {
    const base = [msg("a"), msg("b")];
    const stored = [msg("a"), msg("b"), msg("fromOtherTab")];
    const out = mergeQueue(stored, base, [msg("b")]);
    expect(out.map((m) => m.id)).toEqual(["b", "fromOtherTab"]);
  });

  it("still drops what this tab removed", () => {
    const out = mergeQueue([msg("a"), msg("b")], [msg("a"), msg("b")], [msg("b")]);
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  // Asymmetric on purpose: a re-send is deduped by the shared message id, a lost
  // message is not recoverable at all.
  it("keeps an item this tab still wants even after another tab dequeued it", () => {
    const out = mergeQueue([], [msg("a")], [msg("a")]);
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("drainQueue", () => {
  function harness(opts: {
    committed?: string[];
    editingAfter?: number;
    failOn?: string;
  } = {}) {
    const log: string[] = [];
    const committed = new Set(opts.committed ?? []);
    let sends = 0;
    return {
      log,
      io: {
        editing: () => opts.editingAfter !== undefined && sends >= opts.editingAfter,
        committed: () => committed,
        dequeue: (id: string) => log.push(`dequeue:${id}`),
        setSending: (m: QueuedMessage | null) => log.push(`sending:${m?.id ?? "none"}`),
        send: async (_text: string, _refs: FileRef[], id: string) => {
          sends++;
          log.push(`send:${id}`);
          // The real `send` inserts the optimistic bubble carrying this id before
          // the POST, so the transcript holds it from here on.
          committed.add(id);
          return id !== opts.failOn;
        },
      },
    };
  }

  // The hazard: the item was removed from localStorage BEFORE the POST, so a tab
  // closed in between lost the text — storage no longer had it and the request had
  // not committed. The dequeue must follow the send, never precede it.
  it("dequeues an item only after its send has resolved", async () => {
    const h = harness();
    await drainQueue([msg("a"), msg("b")], h.io);
    expect(h.log).toEqual([
      "sending:a", "send:a", "dequeue:a",
      "sending:b", "send:b", "dequeue:b",
    ]);
  });

  // The other half of the same fix: surviving the crash is only safe if the retry
  // can tell "never sent" from "already sent". The queued id IS the message id, so
  // finding it in the transcript is that proof.
  it("drops an item the transcript already holds instead of sending it twice", async () => {
    const h = harness({ committed: ["a"] });
    await drainQueue([msg("a"), msg("b")], h.io);
    expect(h.log).toEqual(["dequeue:a", "sending:b", "send:b", "dequeue:b"]);
  });

  it("dequeues a failed item and stops the burst", async () => {
    // `send` puts the text back in the COMPOSER on a hard failure, so leaving it
    // queued as well would draw the same message twice and re-fire it immediately.
    const h = harness({ failOn: "a" });
    await drainQueue([msg("a"), msg("b")], h.io);
    expect(h.log).toEqual(["sending:a", "send:a", "dequeue:a"]);
  });

  it("parks the whole queue while a ghost editor is open", async () => {
    const h = harness({ editingAfter: 0 });
    await drainQueue([msg("a"), msg("b")], h.io);
    expect(h.log).toEqual([]);
  });

  it("stops at the item being edited and leaves the rest queued", async () => {
    const h = harness({ editingAfter: 1 });
    await drainQueue([msg("a"), msg("b"), msg("c")], h.io);
    expect(h.log).toEqual(["sending:a", "send:a", "dequeue:a"]);
  });
});
