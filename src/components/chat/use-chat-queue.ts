"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { FileRef } from "@/lib/constants";

export const QUEUE_PREFIX = "unclaw:queue:";

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
