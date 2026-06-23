"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  Plus,
  Settings,
  FolderKanban,
  Archive,
  Send,
  LogOut,
  Search,
  ChevronsUpDown,
  Monitor,
  Sun,
  Moon,
  Loader2,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ClawMark } from "@/components/brand/claw-mark";
import { useTheme } from "@/components/providers";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { ProjectSelector } from "@/components/projects/project-selector";
import { ChatSearch } from "@/components/chat/chat-search";
import { ChatContextMenu } from "@/components/chat/chat-context-menu";
import { cn } from "@/lib/utils";

type ChatItem = {
  id: string;
  title: string | null;
  projectId: string | null;
  pinned: boolean | null;
  archived: boolean | null;
  updatedAt: string | null;
  source: string | null;
  visibility: string | null;
  shareToken: string | null;
  // An assistant reply landed since the user last opened this chat. Derived
  // server-side from chats.lastReadAt; drives the unread dot.
  unread?: boolean;
  // A task is queued/generating for this chat right now. Seeded by the API,
  // kept live by SSE task:start/task:finish; drives the working spinner.
  running?: boolean;
};

// Mirror the server's ORDER BY (pinned DESC, updatedAt DESC, id DESC) so the
// client-side merge keeps pages in the same order the cursor paginates by —
// a chat that streams in on scroll, or gets bumped by new activity, lands
// exactly where the server would have put it.
function sortChats(list: ChatItem[]): ChatItem[] {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

// Merge a freshly-fetched batch into the loaded list: incoming rows overwrite
// existing ones by id (server fields are authoritative), new ones are added,
// and already-loaded older pages are preserved — so an SSE-driven head refresh
// updates titles/unread/running and ordering without discarding the user's
// scrolled-in pages.
function mergeChats(prev: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const map = new Map(prev.map((c) => [c.id, c]));
  for (const c of incoming) map.set(c.id, { ...map.get(c.id), ...c });
  return sortChats([...map.values()]);
}

type DateGroupKey = "today" | "yesterday" | "thisWeek" | "older";

function groupByDate(chats: ChatItem[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  // Presentation-neutral keys — the component maps them to translated labels.
  const groups: { key: DateGroupKey; chats: ChatItem[] }[] = [
    { key: "today", chats: [] },
    { key: "yesterday", chats: [] },
    { key: "thisWeek", chats: [] },
    { key: "older", chats: [] },
  ];

  for (const chat of chats) {
    const date = chat.updatedAt ? new Date(chat.updatedAt) : new Date(0);
    if (date >= today) groups[0].chats.push(chat);
    else if (date >= yesterday) groups[1].chats.push(chat);
    else if (date >= weekAgo) groups[2].chats.push(chat);
    else groups[3].chats.push(chat);
  }

  return groups.filter((g) => g.chats.length > 0);
}

// Up-to-two-letter monogram for the avatar fallback when a user has no photo.
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** A chat's title that softly de-blurs in when it changes after mount — i.e.
 *  when a new chat's placeholder is replaced by its generated title (or a manual
 *  rename). Stays still on first render and on refetches that don't change it,
 *  so only a genuine title change animates. */
function ChatTitle({ title, fallback }: { title: string | null; fallback: string }) {
  const display = title || fallback;
  // Keying the span by its text makes a title change (placeholder → generated
  // title, or a rename) remount a fresh element, which replays the CSS de-blur.
  // A refetch that returns the same text keeps the key, so it never re-animates.
  return <span key={display} className="min-w-0 flex-1 truncate animate-title-swap">{display}</span>;
}

/** Trailing status affordance on a chat row. "Working" (a task is generating)
 *  outranks "unread" — a running chat is by definition the freshest, so the
 *  spinner subsumes the dot until the reply lands and it flips to unread. */
function ChatStatusDot({
  unread,
  running,
  labels,
}: {
  unread?: boolean;
  running?: boolean;
  labels: { unread: string; working: string };
}) {
  if (running) {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={labels.working} />;
  }
  if (unread) {
    return <span className="size-2 shrink-0 rounded-full bg-primary" role="status" aria-label={labels.unread} />;
  }
  return null;
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("nav");
  const tTheme = useTranslations("theme");
  const { toggleSidebar, state: sidebarState, setOpenMobile, openMobile, isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const { data: session } = authClient.useSession();
  const signOut = useCallback(async () => {
    await authClient.signOut();
    router.push("/login");
  }, [router]);
  const [chats, setChats] = useState<ChatItem[]>([]);
  // Distinguishes "still loading" from "loaded, genuinely empty" so the first
  // paint shows skeleton rows instead of flashing the empty state before the
  // list arrives. Stays true after the first load, so search/SSE refetches
  // never re-flash the skeleton.
  const [loaded, setLoaded] = useState(false);
  // Keyset cursor for the next page (from the X-Next-Cursor header). Null once
  // the list is fully loaded — also the signal that hides the scroll sentinel.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Telegram chats can pile up; show the most recent and tuck the rest behind a
  // toggle so the section stays compact at the top of the list.
  const [showAllTelegram, setShowAllTelegram] = useState(false);
  const activeChatId = pathname.startsWith("/chat/") ? pathname.split("/")[2] : null;

  // Debounce search by 300ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const baseParams = useCallback(() => {
    const params = new URLSearchParams();
    if (selectedProject) params.set("projectId", selectedProject);
    if (debouncedSearch) params.set("search", debouncedSearch);
    return params;
  }, [selectedProject, debouncedSearch]);

  // Reset: replace the list with a fresh first page. For a changed filter set
  // (project/search) or a context-menu action (pin/archive/delete) where stale
  // rows must drop out — merging can't remove rows the server no longer returns.
  const fetchReset = useCallback(() => {
    const params = baseParams();
    fetch(`/api/chats${params.size ? `?${params}` : ""}`)
      .then(async (r) =>
        r.ok
          ? { rows: (await r.json()) as ChatItem[], cursor: r.headers.get("X-Next-Cursor") }
          : { rows: [] as ChatItem[], cursor: null },
      )
      .then(({ rows, cursor }) => {
        setChats(sortChats(rows));
        setNextCursor(cursor);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [baseParams]);

  // Head refresh: re-fetch the first page and MERGE it in — picks up new chats,
  // reordering, and fresh unread/running/title while keeping already-loaded
  // older pages and the scroll position. Leaves nextCursor alone so pagination
  // depth survives. Used for SSE/navigation refreshes.
  const refreshHead = useCallback(() => {
    const params = baseParams();
    fetch(`/api/chats${params.size ? `?${params}` : ""}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ChatItem[]) => setChats((prev) => mergeChats(prev, rows)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [baseParams]);

  // Load the next page when the scroll sentinel comes into view.
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || !nextCursor) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const params = baseParams();
    params.set("cursor", nextCursor);
    fetch(`/api/chats?${params}`)
      .then(async (r) =>
        r.ok
          ? { rows: (await r.json()) as ChatItem[], cursor: r.headers.get("X-Next-Cursor") }
          : { rows: [] as ChatItem[], cursor: null },
      )
      .then(({ rows, cursor }) => {
        setChats((prev) => mergeChats(prev, rows));
        setNextCursor(cursor);
      })
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [baseParams, nextCursor]);

  // Filter change (project/search) or first mount → reset list + pagination.
  useEffect(() => {
    fetchReset();
  }, [fetchReset]);

  // Navigation → merge-refresh (keeps scroll) and mark the opened chat read so
  // its unread dot clears. The dot is also suppressed for the active chat in the
  // render below, so a reply that finishes while you're watching never flips it.
  const refreshHeadRef = useRef(refreshHead);
  useEffect(() => { refreshHeadRef.current = refreshHead; }, [refreshHead]);
  useEffect(() => {
    refreshHeadRef.current();
  }, [pathname]);

  // Persist "read" on open. The dot for the active chat is already suppressed in
  // the render (so it never shows while you're looking), and the merge-refresh
  // that fires on this same navigation reconciles the flag from the server — so
  // no optimistic local clear is needed here.
  const markRead = useCallback((id: string) => {
    fetch(`/api/chats/${id}/read`, { method: "POST" }).catch(() => {});
  }, []);
  // The SSE handler (set up once) reads the live active chat / markRead via refs.
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);
  const markReadRef = useRef(markRead);
  useEffect(() => { markReadRef.current = markRead; }, [markRead]);
  useEffect(() => {
    if (!activeChatId) return;
    markRead(activeChatId);
  }, [activeChatId, markRead]);

  // Lazy-load the next page when the sentinel scrolls into view. Re-binds after
  // each page (nextCursor changes) so the freshly-rendered sentinel is observed;
  // the root is the sidebar's own scroll container, not the viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const root = el.closest('[data-slot="sidebar-content"]') as HTMLElement | null;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMoreRef.current(); },
      { root, rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor]);

  // On mobile the sidebar is a full-screen sheet; once the user navigates it
  // must get out of the way. A route change covers most cases — the explicit
  // close on the "new chat" links handles tapping it while already on /chat
  // (same pathname, so this effect wouldn't fire).
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  // Full-screen on mobile → the Back gesture should close the nav, not navigate.
  useBackDismiss(isMobile && openMobile, () => setOpenMobile(false));

  // Keep the list live: a brand-new chat only hits the DB once its first message
  // is sent (no route change fires then), and titles are generated a moment after
  // a task finishes. Subscribe to the same task event stream the chat panel uses
  // and refetch (debounced) when a chat appears, finishes, or arrives externally.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout>;
    let debounce: ReturnType<typeof setTimeout>;
    let delay = 1000;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => refreshHeadRef.current(), 400);
    };
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => { delay = 1000; };
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data) as { type?: string; chatId?: string; title?: string };
          // A generated title arrives once, after a new chat's first turn. Swap it
          // in place (ChatTitle animates the change) instead of a full refetch —
          // no flicker, and it lands even if the chat isn't in the fetched window.
          if (d.type === "chat:title" && d.chatId && d.title) {
            const { chatId: cid, title } = d;
            setChats((prev) => prev.map((c) => (c.id === cid ? { ...c, title } : c)));
          } else if (d.type === "task:start" && d.chatId) {
            // Flip the spinner on instantly; the debounced merge-refresh then
            // surfaces brand-new chats and reconciles ordering authoritatively.
            const cid = d.chatId;
            setChats((prev) => prev.map((c) => (c.id === cid ? { ...c, running: true } : c)));
            refresh();
          } else if (d.type === "task:finish" && d.chatId) {
            // Reply done: drop the spinner now. The merge-refresh brings the
            // fresh unread flag (set when the chat isn't the one being viewed).
            const cid = d.chatId;
            setChats((prev) => prev.map((c) => (c.id === cid ? { ...c, running: false } : c)));
            // If you're watching this chat, the reply you just saw complete is
            // read — re-stamp lastReadAt (the open-time stamp predates the reply)
            // so it doesn't resurface as unread the moment you navigate away.
            if (cid === activeChatIdRef.current) markReadRef.current(cid);
            refresh();
          } else if (d.type === "new_message") {
            refresh();
          }
        } catch { /* ignore parse errors */ }
      };
      es.onerror = () => {
        es?.close();
        clearTimeout(reconnect);
        reconnect = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    };
    connect();
    return () => {
      clearTimeout(reconnect);
      clearTimeout(debounce);
      es?.close();
    };
  }, []);

  // Telegram chats are a distinct kind — read-only in the web UI — so they get
  // their own section instead of mixing into the date-grouped web chats.
  const TELEGRAM_COLLAPSED = 5;
  const telegramChats = chats.filter((c) => c.source === "telegram" && !c.archived);
  const visibleTelegramChats = showAllTelegram ? telegramChats : telegramChats.slice(0, TELEGRAM_COLLAPSED);
  const hiddenTelegramCount = telegramChats.length - visibleTelegramChats.length;
  const webChats = chats.filter((c) => c.source !== "telegram" && !c.archived);
  const pinnedChats = webChats.filter((c) => c.pinned);
  const regularChats = webChats.filter((c) => !c.pinned);
  const groups = groupByDate(regularChats);
  const statusLabels = { unread: t("unreadReply"), working: t("working") };

  const newChatHref = selectedProject
    ? `/chat?projectId=${selectedProject}`
    : "/chat";

  const user = session?.user;
  const displayName = user?.name || user?.email || t("account");
  const avatarUrl = user?.image;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-2">
        <div className="flex items-center justify-between group-data-[collapsible=icon]:justify-center">
          <div className="flex items-center gap-2">
            <button
              onClick={sidebarState === "collapsed" ? toggleSidebar : undefined}
              className={cn("shrink-0 rounded-md transition-opacity", sidebarState === "collapsed" && "hover:opacity-70 cursor-pointer")}
              title={sidebarState === "collapsed" ? t("expandSidebar") : undefined}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#0a0a0a] text-[#fafafa]" aria-label="unClaw">
                <ClawMark className="h-3.5 w-3.5" />
              </span>
            </button>
            <span className="text-base font-medium group-data-[collapsible=icon]:hidden">unClaw</span>
          </div>
          <SidebarTrigger className="group-data-[collapsible=icon]:hidden" />
        </div>
        <Link
          href={newChatHref}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "hidden h-8 w-8 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:mx-auto")}
          title={t("newChat")}
        >
          <Plus className="h-4 w-4" />
        </Link>
      </SidebarHeader>

      {/* Keep SidebarContent in the layout when collapsed so its `flex-1`
          still pushes the footer (avatar) to the bottom; hide only the
          contents. `contents` adds no box when expanded, `hidden` removes
          the children when collapsed. */}
      <SidebarContent>
       <div className="contents group-data-[collapsible=icon]:hidden">
        <SidebarGroup>
          <SidebarGroupContent>
            <div className="px-2 pb-1">
              <ProjectSelector
                value={selectedProject}
                onChange={setSelectedProject}
              />
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href={newChatHref} />}>
                  <Plus className="h-4 w-4" />
                  <span>{t("newChat")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ChatSearch value={search} onChange={setSearch} />

        {/* First-load placeholder: skeleton rows hold the list's shape until the
            fetch resolves, so the panel never flashes the empty state and the
            chats don't pop in. Varied widths read as titles. */}
        {!loaded && (
          <div className="space-y-1 px-2 py-1" aria-hidden>
            {[88, 72, 80, 64, 84, 70, 58].map((w, i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded-md bg-sidebar-accent/70"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        )}

        {telegramChats.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {t("telegram")}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {visibleTelegramChats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <ChatContextMenu chat={chat} onUpdate={fetchReset}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <ChatStatusDot
                          unread={!!chat.unread && chat.id !== activeChatId}
                          running={chat.running}
                          labels={statusLabels}
                        />
                        <ChatTitle title={chat.title} fallback={t("newChat")} />
                      </SidebarMenuButton>
                    </ChatContextMenu>
                  </SidebarMenuItem>
                ))}
                {(hiddenTelegramCount > 0 || showAllTelegram) && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setShowAllTelegram((v) => !v)}
                      className="text-muted-foreground"
                    >
                      <span className="truncate">
                        {showAllTelegram ? t("showLess") : t("showMore", { count: hiddenTelegramCount })}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {pinnedChats.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("pinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinnedChats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <ChatContextMenu chat={chat} onUpdate={fetchReset}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <ChatStatusDot
                          unread={!!chat.unread && chat.id !== activeChatId}
                          running={chat.running}
                          labels={statusLabels}
                        />
                        <ChatTitle title={chat.title} fallback={t("newChat")} />
                      </SidebarMenuButton>
                    </ChatContextMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {groups.map((group) => (
          <SidebarGroup key={group.key}>
            <SidebarGroupLabel>{t(`groups.${group.key}`)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.chats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <ChatContextMenu chat={chat} onUpdate={fetchReset}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <ChatStatusDot
                          unread={!!chat.unread && chat.id !== activeChatId}
                          running={chat.running}
                          labels={statusLabels}
                        />
                        <ChatTitle title={chat.title} fallback={t("newChat")} />
                      </SidebarMenuButton>
                    </ChatContextMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {/* Infinite-scroll trigger: when this scrolls into view the next page
            loads. Only rendered while more pages remain, so it doubles as the
            "fully loaded" signal. */}
        {nextCursor && (
          <div ref={sentinelRef} className="flex justify-center py-3" aria-hidden>
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        )}

        {loaded && chats.length === 0 && (
          <div className="animate-blur-rise flex flex-col items-center px-4 py-10 text-center">
            <ClawMark className="mb-3 h-9 w-9 text-foreground opacity-15" />
            <p className="text-xs text-muted-foreground">
              {debouncedSearch ? t("noChatsFound") : t("startNewChat")}
            </p>
          </div>
        )}
       </div>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("account")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md p-1.5 text-left outline-none transition-colors",
              "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[popup-open]:bg-sidebar-accent",
              "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            )}
          >
            <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sidebar-accent text-xs font-medium text-foreground">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                initials(displayName)
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium group-data-[collapsible=icon]:hidden">
              {displayName}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-56"
          >
            <DropdownMenuItem
              onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
            >
              <Search className="size-4" />
              {t("search")}
              <DropdownMenuShortcut>
                {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K"}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/projects" />}>
              <FolderKanban className="size-4" />
              {t("projects")}
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/chat/archived" />}>
              <Archive className="size-4" />
              {t("archived")}
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {theme === "light" ? (
                  <Sun className="size-4" />
                ) : theme === "dark" ? (
                  <Moon className="size-4" />
                ) : (
                  <Monitor className="size-4" />
                )}
                {t("theme")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) => setTheme(value as "light" | "dark" | "system")}
                >
                  <DropdownMenuRadioItem value="system">
                    <Monitor className="size-4" />
                    {tTheme("system")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">
                    <Sun className="size-4" />
                    {tTheme("light")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon className="size-4" />
                    {tTheme("dark")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem render={<Link href="/settings" />}>
              <Settings className="size-4" />
              {t("settings")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={signOut}>
              <LogOut className="size-4" />
              {t("signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
