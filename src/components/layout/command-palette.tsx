"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { nanoid } from "nanoid";
import {
  MessageSquarePlus,
  Settings,
  Plug,
  Bot,
  PanelLeft,
  Moon,
  FolderKanban,
  FolderOpen,
  Brain,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import { useSidebar } from "@/components/ui/sidebar";
import { useTheme } from "@/components/providers";

export function CommandPalette() {
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
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Chat">
          <CommandItem onSelect={() => run(() => router.push(`/chat/${nanoid()}`))}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            New Chat
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => run(() => router.push("/projects"))}>
            <FolderKanban className="mr-2 h-4 w-4" />
            Projects
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/files"))}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Files
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings"))}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings/memory"))}>
            <Brain className="mr-2 h-4 w-4" />
            Memory
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings/connections"))}>
            <Plug className="mr-2 h-4 w-4" />
            Connections
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings/integrations"))}>
            <Bot className="mr-2 h-4 w-4" />
            Integrations
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Preferences">
          <CommandItem onSelect={() => run(toggleSidebar)}>
            <PanelLeft className="mr-2 h-4 w-4" />
            Toggle Sidebar
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(cycleTheme)}>
            <Moon className="mr-2 h-4 w-4" />
            Toggle Theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
