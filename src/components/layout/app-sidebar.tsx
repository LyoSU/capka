"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageSquare, Plus, Settings } from "lucide-react";
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
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { buttonVariants } from "@/components/ui/button";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { cn } from "@/lib/utils";

type ChatItem = {
  id: string;
  title: string | null;
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
  const [chats, setChats] = useState<ChatItem[]>([]);

  useEffect(() => {
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : []))
      .then(setChats)
      .catch(() => {});
  }, [pathname]); // refresh on navigation

  const groups = groupByDate(chats);
  const activeChatId = pathname.startsWith("/chat/") ? pathname.split("/")[2] : null;

  return (
    <Sidebar>
      <SidebarHeader className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-base font-medium">AntiClaw</span>
          <SidebarTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/chat" />}>
                  <Plus className="h-4 w-4" />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.chats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <SidebarMenuButton
                      render={<Link href={`/chat/${chat.id}`} />}
                      data-active={activeChatId === chat.id || undefined}
                    >
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {chat.title || "New Chat"}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {chats.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            No chats yet
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="p-3">
        <SidebarSeparator />
        <div className="flex items-center justify-between pt-2">
          <ThemeSwitcher />
          <Link
            href="/settings"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </Link>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
