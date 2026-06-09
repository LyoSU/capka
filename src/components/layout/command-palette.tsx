"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nanoid } from "nanoid";
import {
  MessageSquarePlus,
  Settings,
  Plug,
  Bot,
  PanelLeft,
  Moon,
  FolderKanban,
  Brain,
  Keyboard,
  Search,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";
import { useSidebar } from "@/components/ui/sidebar";
import { useTheme } from "@/components/providers";

export function CommandPalette() {
  const t = useTranslations("commandPalette");
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "n") {
        e.preventDefault();
        router.push(`/chat/${nanoid()}`);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  function run(fn: () => void) {
    setOpen(false);
    fn();
  }

  function cycleTheme() {
    const order = ["system", "light", "dark"] as const;
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={t("search")} />
      <CommandList>
        <CommandEmpty>{t("noResults")}</CommandEmpty>

        <CommandGroup heading={t("groups.chat")}>
          <CommandItem onSelect={() => run(() => router.push(`/chat/${nanoid()}`))}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            {t("newChat")}
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t("groups.navigation")}>
          <CommandItem onSelect={() => run(() => router.push("/projects"))}>
            <FolderKanban className="mr-2 h-4 w-4" />
            {t("projects")}
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings"))}>
            <Settings className="mr-2 h-4 w-4" />
            {t("settings")}
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings/memory"))}>
            <Brain className="mr-2 h-4 w-4" />
            {t("memory")}
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings/connections"))}>
            <Plug className="mr-2 h-4 w-4" />
            {t("connections")}
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings/integrations"))}>
            <Bot className="mr-2 h-4 w-4" />
            {t("integrations")}
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t("groups.preferences")}>
          <CommandItem onSelect={() => run(toggleSidebar)}>
            <PanelLeft className="mr-2 h-4 w-4" />
            {t("toggleSidebar")}
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(cycleTheme)}>
            <Moon className="mr-2 h-4 w-4" />
            {t("toggleTheme")}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t("groups.shortcuts")}>
          <CommandItem disabled>
            <Keyboard className="mr-2 h-4 w-4" />
            {t("commandPalette")}
            <CommandShortcut>⌘K</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            {t("newChat")}
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <PanelLeft className="mr-2 h-4 w-4" />
            {t("toggleSidebar")}
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <Search className="mr-2 h-4 w-4" />
            {t("searchChats")}
            <CommandShortcut>⌘⇧F</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
