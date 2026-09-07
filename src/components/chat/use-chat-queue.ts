"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { FileRef } from "@/lib/constants";

export const QUEUE_PREFIX = "capka:queue:";

/** A message typed while a reply was streaming, waiting its turn to be sent.
 *  Attachments are already-uploaded refs (eager upload), so a queued turn just
 *  carries its refs — no bytes are held here. */
export type QueuedMessage = { id: string; text: string; refs: FileRef[] };

/**
 * Per-chat send queue, persisted to localStorage so messages lined up behind a
 * streaming reply survive a chat switch, a reload, or a closed tab — the same
 * treatment {@link useChatDraft} gives the composer draft. ChatPanel is mounted
 * with `key={chatId}`, so navigating away unmounts it and would otherwise drop
 * the in-memory queue on the floor; localStorage outlives the remount, and the
 * drain effect picks the queue back up when the chat is free again.
 *
 * Built on useSyncExternalStore + StorageEvent like the draft hook: a stable
 * empty-array SSR snapshot avoids hydration churn, and writing dispatches a
 * `storage` event so this document re-renders (the native event only crosses
 * tabs) — which also keeps the queue in sync if the chat is open twice.
 */
function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

// useSyncExternalStore compares snapshots by reference and re-reads on every
// render, so getSnapshot MUST return the same array until the data actually
// changes — re-parsing JSON each call hands back a fresh array and spins React
// into an infinite render loop. Cache the parsed value keyed by its raw string;
// a single shared empty array keeps the "nothing queued" snapshot stable too.
const EMPTY: QueuedMessage[] = [];
const cache = new Map<string, { raw: string; parsed: QueuedMessage[] }>();

export function readQueue(key: string): QueuedMessage[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return EMPTY;
  }
  if (!raw) return EMPTY;
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.parsed;
  try {
    const parsed = JSON.parse(raw) as QueuedMessage[];
    cache.set(key, { raw, parsed });
    return parsed;
  } catch {
    return EMPTY;
  }
}

/**
 * The queue as the transcript should draw it: the item currently being sent
 * first, then whatever is still lined up behind it.
 *
 * The in-flight item needs holding because the drain removes it from storage
 * the moment it STARTS (so a reload mid-drain can't re-send it) — several
 * hundred ms before its real bubble exists. Without this it would vanish from
 * the transcript and reappear, leaving a hole across the folder-sync push.
 *
 * `messageIds` is what closes the hold: the drain passes the queued id straight
 * through as the message id, so the optimistic bubble carries the SAME id — and
 * that bubble is inserted synchronously, before the POST. The instant the id
 * shows up in the transcript the ghost has been replaced by the real thing and
 * must be dropped, or the same message renders twice for the whole round-trip.
 *
 * The `queued` filter guards the other direction: the same chat open in a second
 * tab can re-observe the item in localStorage while this tab is sending it.
 */
export function visibleQueue({
  queued,
  sending,
  messageIds,
}: {
  queued: QueuedMessage[];
  sending: QueuedMessage | null;
  messageIds: ReadonlySet<string>;
}): QueuedMessage[] {
  const held = sending && !messageIds.has(sending.id) ? sending : null;
  const rest = queued.filter((q) => !messageIds.has(q.id) && q.id !== sending?.id);
  return held ? [held, ...rest] : rest;
}

/**
 * Fold a queue this tab computed back onto whatever is stored NOW.
 *
 * `base` is the queue this tab read before computing, `next` what it wants, `stored`
 * what is on disk at the moment of writing. Anything in `stored` that this tab never
 * saw (in neither `base` nor `next`) was written by ANOTHER tab between the two, and
 * a plain `setItem(next)` would erase it — the same chat open twice, one tab
 * enqueueing while the other dequeues, and one person's typed message is gone with
 * no copy anywhere.
 *
 * Deliberately asymmetric: an item this tab still wants is kept even if another tab
 * has since dequeued it. Re-sending is recoverable — the queued id rides into the
 * POST as the message id, so the server's insert no-ops and the drain drops any item
 * it finds already in the transcript — whereas losing typed text is not.
 *
 * NOT a compare-and-swap, and knowingly so. `getItem` and `setItem` here sit in one
 * synchronous block with nothing awaited between them, but localStorage offers no
 * atomic swap across tabs, so two tabs interleaving inside that window can still
 * both observe the same array and the second write erase the first tab's item. The
 * fix that closes it for real is a key per item, which trades this window for a
 * storage-schema change: enumerating keys on every read, a separate sequence field
 * to keep the send order, and a migration for queues already on disk. Declined as
 * the larger risk of the two — the window is microseconds wide and needs the same
 * chat open twice with both tabs typing into it, whereas the guaranteed loss this
 * hook used to have (dequeue before the POST committed) is closed in `drainQueue`.
 * Recorded here rather than fixed; revisit if the queue ever holds anything a user
 * cannot simply retype.
 */
export function mergeQueue(
  stored: QueuedMessage[],
  base: QueuedMessage[],
  next: QueuedMessage[],
): QueuedMessage[] {
  const seen = new Set([...base, ...next].map((m) => m.id));
  const foreign = stored.filter((m) => !seen.has(m.id));
  // Identity-stable on the common path: no foreign item means `next` is the answer,
  // which keeps the useSyncExternalStore snapshot from churning.
  return foreign.length ? [...next, ...foreign] : next;
}

/**
 * One pass of the send queue: each item sent as its own message, in order, so the
 * server folds the whole burst into a single reply.
 *
 * Extracted from ChatPanel because the ORDER of `dequeue` against `send` is the
 * whole behaviour. It used to dequeue as a send STARTED, which meant a tab closed
 * during the POST lost the text outright — localStorage no longer held it and the
 * request had not committed. Dequeuing only AFTER `send` resolves moves the window
 * to a harmless place: the item survives the crash and is re-drained, and `committed`
 * is what stops the re-drain from sending it twice (the queued id is the message id,
 * so its presence in the loaded transcript is proof the POST landed).
 *
 * The failure path dequeues too, and must: `send` puts the text back in the COMPOSER
 * on a hard failure, so leaving it queued as well would show the same message twice
 * and re-fire it the moment the effect re-ran.
 */
export async function drainQueue(
  batch: readonly QueuedMessage[],
  io: {
    /** An open ghost editor parks the whole queue — re-read per item, since a
     *  burst takes a round-trip each and the pencil can be clicked mid-way. */
    editing: () => boolean;
    /** Message ids the transcript already holds, read live. */
    committed: () => ReadonlySet<string>;
    dequeue: (id: string) => void;
    setSending: (m: QueuedMessage | null) => void;
    send: (text: string, refs: FileRef[], id: string) => Promise<boolean>;
  },
): Promise<void> {
  for (const item of batch) {
    if (io.editing()) break;
    if (io.committed().has(item.id)) {
      // Already landed — this is the item a previous drain sent before its tab
      // closed, or one a second tab sent. Drop it instead of asking twice.
      io.dequeue(item.id);
      continue;
    }
    io.setSending(item);
    const ok = await io.send(item.text, item.refs, item.id);
    io.dequeue(item.id);
    // A hard failure stops the burst rather than hammering a failing server; the
    // rest stay queued and re-drain when the chat is free.
    if (!ok) break;
  }
}

export function useChatQueue(chatId: string) {
  const key = QUEUE_PREFIX + chatId;

  const queued = useSyncExternalStore(
    subscribe,
    () => readQueue(key),
    () => EMPTY,
  );

  const write = useCallback(
    (next: QueuedMessage[]) => {
      try {
        if (next.length) localStorage.setItem(key, JSON.stringify(next));
        else localStorage.removeItem(key);
        window.dispatchEvent(new StorageEvent("storage", { key }));
      } catch {}
    },
    [key],
  );

  // Mirrors a useState setter (value OR updater) so it's a drop-in for the old
  // `setQueued`. The updater reads the live stored value — never a stale closure
  // — so concurrent enqueue/remove/drain all compose against the latest queue.
  //
  // Re-read once more at write time and merged: `localStorage.setItem` is a blind
  // whole-array overwrite, so a second tab that wrote between our read and our write
  // would be erased. See {@link mergeQueue}.
  const setQueued = useCallback(
    (next: QueuedMessage[] | ((cur: QueuedMessage[]) => QueuedMessage[])) => {
      const base = readQueue(key);
      const wanted = typeof next === "function" ? next(base) : next;
      write(mergeQueue(readQueue(key), base, wanted));
    },
    [key, write],
  );

  return { queued, setQueued };
}
