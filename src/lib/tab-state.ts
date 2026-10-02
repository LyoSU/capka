/** What the browser tab (title, favicon, app badge) says about the person's chats.
 *
 *  One state, by priority: a chat stopped on the person (`needs`) outranks one the
 *  model is still working on (`working`), which outranks a finished reply they have
 *  not seen yet (`done`). `count` is what the app badge shows — the things waiting
 *  on the person, never the ones merely in progress. */
export type TabState = { kind: "needs" | "working" | "done" | "idle"; count: number };

type Row = { id: string; unread?: boolean; running?: boolean; archived?: boolean | null; attention?: unknown };

export function deriveTabState(
  chats: Row[],
  { activeChatId, doneWhileAway }: { activeChatId: string | null; doneWhileAway: boolean },
): TabState {
  const live = chats.filter((c) => !c.archived);
  const needs = live.filter((c) => c.attention && !c.running).length;
  // The open chat is never unread (opening it marks it read), so a reply that lands
  // in it while the tab is in the background is tracked separately.
  const unread = live.filter((c) => c.unread && !c.attention && c.id !== activeChatId).length + (doneWhileAway ? 1 : 0);
  if (needs > 0) return { kind: "needs", count: needs + unread };
  if (live.some((c) => c.running)) return { kind: "working", count: unread };
  if (unread > 0) return { kind: "done", count: unread };
  return { kind: "idle", count: 0 };
}

// The state itself rides the favicon dot; the title carries only the count of
// things waiting on the person, the "(2) Inbox" form every mail client uses.
// The glyph alternation strips what earlier builds of this hook wrote.
const PREFIX = /^(?:[\u25CF\u27F3\u2713] )?(?:\(\d+\) )?/;

/** The title with our prefix applied; anything we wrote before is stripped first, so
 *  re-applying is idempotent and the rest of the title stays Next's. */
export function prefixTitle(title: string, state: TabState): string {
  const base = title.replace(PREFIX, "");
  return state.kind !== "working" && state.count > 0 ? `(${state.count}) ${base}` : base;
}
