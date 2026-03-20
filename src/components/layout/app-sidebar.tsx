"use client";

import Link from "next/link";
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
} from "@/components/ui/sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-base font-medium">AntiClaw</span>
          <Link
            href="/chat"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            <Plus className="h-4 w-4" />
            <span>New Chat</span>
          </Link>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/chat" />}>
                  <MessageSquare className="h-4 w-4" />
                  <span>All Chats</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
