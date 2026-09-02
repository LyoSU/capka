"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nanoid } from "nanoid";
import {
  MessageSquarePlus,
  Settings,
  PanelLeft,
  Moon,
  FolderKanban,
  Keyboard,
  Search,
  Link2,
  Brain,
  Sparkles,
  CalendarClock,
  Bot,
  Users,
  Wallet,
  Lock,
  BarChart3,
  ScrollText,
  Download,
  type LucideIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandKbd,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";
import { useSidebar } from "@/components/ui/sidebar";
import { useTheme } from "@/components/providers";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useBilling } from "@/hooks/use-billing";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { SETTINGS_DIRECTORY, visibleSettings } from "@/lib/settings-directory";

/** The glyph of the settings page a row lives on — the same icons the settings
 *  sidebar draws for those pages, so a palette result and the page it opens look
 *  alike. A column of identical gears said nothing about where each row went. */
const PAGE_ICONS: [string, LucideIcon][] = [
  ["/settings/connections", Link2],
  ["/settings/memory", Brain],
  ["/settings/skills", Sparkles],
  ["/settings/automations", CalendarClock],
  ["/settings/agent", Bot],
  ["/settings/users", Users],
  ["/settings/billing", Wallet],
  ["/settings/security", Lock],
  ["/settings/usage", BarChart3],
  ["/settings/activity", ScrollText],
  ["/settings/updates", Download],
];
function pageIcon(href: string): LucideIcon {
  return PAGE_ICONS.find(([prefix]) => href.startsWith(prefix))?.[1] ?? Settings;
}

export function CommandPalette() {
  const t = useTranslations("commandPalette");
  // Root-namespaced: directory entries carry full key paths so a palette row reads
  // the same words as the settings row it opens.
  const tRoot = useTranslations();
  const isAdmin = useIsAdmin();
  // Same gate the settings sidebar applies: on a shared-key instance the provider
  // page is not a place a member should be sent.
  const { billing } = useBilling();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();
  const key = useShortcutLabel();

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

    // The sidebar footer (and anywhere else) can open the palette by click
    // without reaching into this component's state — it just fires the event.
    function open() {
      setOpen(true);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("open-command-palette", open);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("open-command-palette", open);
    };
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
            <MessageSquarePlus />
            {t("newChat")}
            <CommandShortcut>{key("N")}</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t("groups.navigation")}>
          <CommandItem onSelect={() => run(() => router.push("/projects"))}>
            <FolderKanban />
            {t("projects")}
          </CommandItem>
          <CommandItem onSelect={() => run(() => router.push("/settings"))}>
            <Settings />
            {t("settings")}
          </CommandItem>
        </CommandGroup>

        {/* Every individual setting, from the same declared index the settings
            sidebar filters — so ⌘K reaches a single switch, not just the page it
            sits on. This replaced three hardcoded links to Memory, Providers and
            Integrations: a second, shorter list of the same places, which could
            only ever fall behind the first. */}
        <CommandGroup heading={t("groups.settings")}>
          {visibleSettings(SETTINGS_DIRECTORY, { isAdmin, ownKeysAllowed: billing?.ownKeysAllowed ?? false }).map((entry) => {
            const Icon = pageIcon(entry.href);
            return (
            <CommandItem
              key={`${entry.href}-${entry.label}`}
              // cmdk matches on the item's own text; the synonyms someone actually
              // types ("prompt", "gpt") live in the index, so hand them over too.
              keywords={entry.keywordsKey ? tRoot(entry.keywordsKey).split(/\s+/) : undefined}
              onSelect={() => run(() => router.push(entry.href))}
            >
              <Icon />
              {tRoot(entry.label)}
              <span className="ml-auto text-xs text-muted-foreground">{tRoot(entry.page)}</span>
            </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandGroup heading={t("groups.preferences")}>
          <CommandItem onSelect={() => run(toggleSidebar)}>
            <PanelLeft />
            {t("toggleSidebar")}
            <CommandShortcut>{key("B")}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(cycleTheme)}>
            <Moon />
            {t("toggleTheme")}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t("groups.shortcuts")}>
          <CommandItem disabled>
            <Keyboard />
            {t("commandPalette")}
            <CommandShortcut>{key("K")}</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <MessageSquarePlus />
            {t("newChat")}
            <CommandShortcut>{key("N")}</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <PanelLeft />
            {t("toggleSidebar")}
            <CommandShortcut>{key("B")}</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <Search />
            {t("searchChats")}
            <CommandShortcut>{key("F", true)}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      {/* The three keys the palette answers to, named once at the foot. It is what
          tells a first-time reader this is a launcher and not a search box. */}
      <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><CommandKbd>↑↓</CommandKbd>{t("hints.navigate")}</span>
        <span className="flex items-center gap-1.5"><CommandKbd>↵</CommandKbd>{t("hints.open")}</span>
        <span className="ml-auto flex items-center gap-1.5"><CommandKbd>esc</CommandKbd>{t("hints.close")}</span>
      </div>
    </CommandDialog>
  );
}
