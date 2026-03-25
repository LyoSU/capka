"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { MessageSquare, Plus, Settings, FolderKanban, Archive } from "lucide-react";
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
};

function groupByDate(chats: ChatItem[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: { label: string; chats: ChatItem[] }[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "This week", chats: [] },
    { label: "Older", chats: [] },
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
  const { toggleSidebar, state: sidebarState } = useSidebar();
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

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

  const pinnedChats = chats.filter((c) => c.pinned && !c.archived);
  const regularChats = chats.filter((c) => !c.pinned && !c.archived);
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
              title={sidebarState === "collapsed" ? "Expand sidebar" : undefined}
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
          title="New Chat"
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
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ChatSearch value={search} onChange={setSearch} />

        {pinnedChats.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Pinned</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinnedChats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <ChatContextMenu chat={chat} onUpdate={fetchChats}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <MessageSquare className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                          {chat.title || "New Chat"}
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
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.chats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <ChatContextMenu chat={chat} onUpdate={fetchChats}>
                      <SidebarMenuButton
                        render={<Link href={`/chat/${chat.id}`} />}
                        data-active={activeChatId === chat.id || undefined}
                      >
                        <MessageSquare className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                          {chat.title || "New Chat"}
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
              {debouncedSearch ? "No chats found" : "Start a new chat to get going"}
            </p>
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="mt-auto p-2">
        <div className="flex items-center justify-between group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1">
          <span className="group-data-[collapsible=icon]:hidden"><ThemeSwitcher /></span>
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <Link
              href="/chat/archived"
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
              title="Archived"
            >
              <Archive className="h-4 w-4" />
            </Link>
            <Link
              href="/projects"
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
              title="Projects"
            >
              <FolderKanban className="h-4 w-4" />
            </Link>
            <Link
              href="/settings"
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8")}
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
