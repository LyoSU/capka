"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Plus, Settings, FolderKanban, Archive, Send } from "lucide-react";
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
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
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

export function AppSidebar() {
  const pathname = usePathname();
  const t = useTranslations("nav");
  const { toggleSidebar, state: sidebarState } = useSidebar();
  const [chats, setChats] = useState<ChatItem[]>([]);
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
      .catch(() => {});
  }, [selectedProject, debouncedSearch]);

  useEffect(() => {
    fetchChats();
  }, [fetchChats, pathname]);

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
              <Image src="/icon.svg" alt="unClaw" width={24} height={24} className="rounded-md" />
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
                <SidebarMenuButton render={<Link href={newChatHref} />}>
                  <Plus className="h-4 w-4" />
                  <span>{t("newChat")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ChatSearch value={search} onChange={setSearch} />

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

        {chats.length === 0 && (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <div className="mb-3 grid grid-cols-3 gap-1 opacity-20">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="h-2 w-2 rounded-sm bg-foreground" />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {debouncedSearch ? t("noChatsFound") : t("startNewChat")}
            </p>
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="mt-auto p-2">
        <div className="flex items-center justify-between group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1">
          <div className="flex items-center gap-2 group-data-[collapsible=icon]:hidden">
            <ThemeSwitcher />
            <kbd className="pointer-events-none select-none text-[10px] text-muted-foreground/60 font-mono" suppressHydrationWarning>
              {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K"}
            </kbd>
          </div>
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <Link
              href="/chat/archived"
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
              title={t("archived")}
            >
              <Archive className="h-4 w-4" />
            </Link>
            <Link
              href="/projects"
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
              title={t("projects")}
            >
              <FolderKanban className="h-4 w-4" />
            </Link>
            <Link
              href="/settings"
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
              title={t("settings")}
            >
              <Settings className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
