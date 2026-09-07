"use client";

/**
 * Where a chat's chrome was left: the workspace column open or shut, and the file
 * that was open in it.
 *
 * Per chat, not global, because it describes a piece of work rather than a taste —
 * one conversation is a spreadsheet you keep the viewer open beside, the next is a
 * question with no files at all. Widths are the opposite and stay global
 * (`capka.layout.sidebar` / `capka.layout.workspace`): those ARE a taste.
 *
 * A chat at its defaults stores nothing — an entry only exists once someone has
 * moved something — so the store is a record of the chats that were arranged, not
 * of every chat ever opened. On top of that it states its own bound: a write keeps
 * the MAX_CHAT_LAYOUTS most recently touched entries and drops the rest, so the
 * key space cannot grow for the life of a browser profile.
 *
 * Every read and write is wrapped: storage throws outright in some contexts
 * (blocked site data, a thumbnail capture), and a remembered panel is never worth
 * a crash.
 */

export const CHAT_LAYOUT_PREFIX = "capka.layout.chat.";

/** Enough for the chats anyone is actually moving between; older ones fall back
 *  to the defaults, which is what they would have shown anyway. */
export const MAX_CHAT_LAYOUTS = 50;

export type ChatLayout = {
  workspaceOpen: boolean;
  /** Workspace-relative path of the file docked in the viewer, or null. */
  previewPath: string | null;
};

const DEFAULTS: ChatLayout = { workspaceOpen: false, previewPath: null };

const keyOf = (chatId: string) => CHAT_LAYOUT_PREFIX + chatId;

/** Which stored entries a write should drop, oldest first, to stay inside `keep`.
 *  An entry with no usable timestamp sorts oldest: it predates the stamping. */
export function keysToPrune(entries: { key: string; at: number }[], keep: number): string[] {
  if (entries.length <= keep) return [];
  return [...entries]
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(0, entries.length - keep)
    .map((e) => e.key);
}

/** Every stored chat layout with its recency stamp. Unparseable entries are
 *  reported with `at: 0` rather than skipped — they are exactly the ones to prune. */
function storedEntries(): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(CHAT_LAYOUT_PREFIX)) continue;
      let at = 0;
      try {
        at = Number((JSON.parse(localStorage.getItem(key) ?? "{}") as { at?: unknown }).at) || 0;
      } catch {}
      out.push({ key, at });
    }
  } catch {}
  return out;
}

/** The chat's remembered layout, or null when it has none (the common case). */
export function readChatLayout(chatId: string): ChatLayout | null {
  try {
    const raw = localStorage.getItem(keyOf(chatId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ChatLayout>;
    return {
      workspaceOpen: v.workspaceOpen === true,
      previewPath: typeof v.previewPath === "string" && v.previewPath ? v.previewPath : null,
    };
  } catch {
    return null;
  }
}

/** Remember a layout, or forget it when it is the default one, then prune. */
export function writeChatLayout(chatId: string, layout: ChatLayout): void {
  try {
    if (layout.workspaceOpen === DEFAULTS.workspaceOpen && layout.previewPath === DEFAULTS.previewPath) {
      localStorage.removeItem(keyOf(chatId));
      return;
    }
    localStorage.setItem(keyOf(chatId), JSON.stringify({ ...layout, at: Date.now() }));
    for (const key of keysToPrune(storedEntries(), MAX_CHAT_LAYOUTS)) localStorage.removeItem(key);
  } catch {}
}

/** Forget just the docked file — the one the workspace no longer has. The open
 *  column is still what the user left, so it stays. */
export function clearPreviewPath(chatId: string): void {
  const stored = readChatLayout(chatId);
  if (!stored?.previewPath) return;
  writeChatLayout(chatId, { ...stored, previewPath: null });
}
