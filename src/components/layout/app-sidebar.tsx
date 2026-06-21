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
};

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
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Telegram chats can pile up; show the most recent and tuck the rest behind a
  // toggle so the section stays compact at the top of the list.
  const [showAllTelegram, setShowAllTelegram] = useState(false);

  // Debounce search by 300ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchChats = useCallback(() => {
    const params = new URLSearchParams();
    if (selectedProject) params.set("projectId", selectedProject);
    if (debouncedSearch) params.set("search", debouncedSearch);
    const url = `/api/chats${params.size ? `?${params}` : ""}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : []))
      .then(setChats)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [selectedProject, debouncedSearch]);

  useEffect(() => {
    fetchChats();
  }, [fetchChats, pathname]);

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
  const fetchChatsRef = useRef(fetchChats);
  useEffect(() => { fetchChatsRef.current = fetchChats; }, [fetchChats]);
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout>;
    let debounce: ReturnType<typeof setTimeout>;
    let delay = 1000;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => fetchChatsRef.current(), 400);
    };
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => { delay = 1000; };
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data) as { type?: string };
          if (d.type === "task:start" || d.type === "task:finish" || d.type === "new_message") refresh();
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
  const activeChatId = pathname.startsWith("/chat/") ? pathname.split("/")[2] : null;

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

      <SidebarContent className="group-data-[collapsible=icon]:hidden">
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
                <SidebarMenuButton render={<Link href={newChatHref} />} onClick={() => setOpenMobile(false)}>
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
                    <ChatContextMenu chat={chat} onUpdate={fetchChats}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <span className="truncate">{chat.title || t("newChat")}</span>
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
                    <ChatContextMenu chat={chat} onUpdate={fetchChats}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <span className="truncate">
                          {chat.title || t("newChat")}
                        </span>
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
                    <ChatContextMenu chat={chat} onUpdate={fetchChats}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <span className="truncate">
                          {chat.title || t("newChat")}
                        </span>
                      </SidebarMenuButton>
                    </ChatContextMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {loaded && chats.length === 0 && (
          <div className="animate-blur-rise flex flex-col items-center px-4 py-10 text-center">
            <ClawMark className="mb-3 h-9 w-9 text-foreground opacity-15" />
            <p className="text-xs text-muted-foreground">
              {debouncedSearch ? t("noChatsFound") : t("startNewChat")}
            </p>
          </div>
        )}
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
