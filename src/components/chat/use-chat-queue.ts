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
  const setQueued = useCallback(
    (next: QueuedMessage[] | ((cur: QueuedMessage[]) => QueuedMessage[])) => {
      write(typeof next === "function" ? next(readQueue(key)) : next);
    },
    [key, write],
  );

  return { queued, setQueued };
}
