"use client";

import { useCallback, useSyncExternalStore } from "react";

const PREFIX = "unclaw:draft:";

/**
 * Per-chat composer draft, persisted to localStorage so a typed-but-unsent
 * message survives a reload, a closed tab, or a failed send. Built on the same
 * useSyncExternalStore + StorageEvent pattern as the workspace panel's view
 * preference: a stable SSR snapshot ("") means the controlled <textarea> never
 * trips a hydration mismatch, and the value adopts the stored draft on the client
 * with no flash. localStorage is the single source of truth, so `setDraft`'s
 * updater form reads the live value — no stale closure on the async
 * restore-after-failure path.
 *
 * An empty draft removes its key rather than storing "", so chats the user only
 * glanced at leave no stale entry. Writing dispatches a `storage` event so this
 * document re-renders (the native event only fires across tabs) — which also
 * keeps the same chat's draft in sync if it's open in two tabs.
 */
function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function useChatDraft(chatId: string) {
  const key = PREFIX + chatId;

  const draft = useSyncExternalStore(
    subscribe,
    () => readDraft(key),
    () => "",
  );

  const write = useCallback(
    (value: string) => {
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
        window.dispatchEvent(new StorageEvent("storage", { key }));
      } catch {}
    },
    [key],
  );

  // Mirrors the useState setter (value OR updater) so it's a drop-in for the old
  // `setInput`. The updater reads from localStorage — always current — so the
  // async restore path can prepend to whatever the user typed since.
  const setDraft = useCallback(
    (next: string | ((cur: string) => string)) => {
      write(typeof next === "function" ? next(readDraft(key)) : next);
    },
    [key, write],
  );

  const clearDraft = useCallback(() => write(""), [write]);

  return { draft, setDraft, clearDraft };
}
