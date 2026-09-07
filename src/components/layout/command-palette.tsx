"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { nanoid } from "nanoid";
import {
  MessageSquare,
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
  User,
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
import { DRAFT_PREFIX } from "@/components/chat/use-chat-draft";

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

type ChatRow = { id: string; title: string | null; projectName?: string | null; updatedAt: string | null };
type MessageHit = {
  messageId: string;
  chatId: string;
  chatTitle: string | null;
  role: string;
  createdAt: string;
  snippet: string;
};

/** Below this the server answers nothing (see /api/search), so neither does the
 *  palette pretend to have looked. */
const MIN_SEARCH = 2;


/** The server marks what it matched with `<<…>>`; this turns those into a
 *  highlight. Split into text nodes rather than set as HTML — the string is a
 *  person's own message, and it is never treated as markup anywhere. */
function highlightSnippet(snippet: string) {
  return snippet.split(/<<(.*?)>>/g).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-brand/15 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
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
  // The palette is also the chat search: what you type filters the static rows
  // AND asks the server for matching chat titles and matching message text.
  // Recent chats fill the group while the field is empty, so opening the palette
  // is a chat switcher before a keystroke.
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<ChatRow[]>([]);
  // Messages whose text matched, and the query those results belong to. The
  // second is what tells "we looked and found nothing" from "we have not asked
  // yet" — without it the empty sentence flashes between keystrokes.
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [resultsFor, setResultsFor] = useState("");
  const locale = useLocale();
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
      } else if (e.shiftKey && e.code === "KeyF") {
        // The chat-search shortcut the sidebar used to own; the palette is the
        // search now. `code`, not `key`: with Shift held the key IS "F".
        e.preventDefault();
        setOpen(true);
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

  // Empty field: recent chats, straight from the list the sidebar shows. Typed
  // field: /api/search, which answers with title matches AND matches inside the
  // messages themselves — so what a person half-remembers saying is enough to
  // find the chat again, not only what the chat happens to be called.
  //
  // Debounced only while typing; the recents fetch on open is immediate. The
  // AbortController drops a stale response that lands after the next keystroke.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const q = query.trim();
    const timer = setTimeout(async () => {
      try {
        if (!q) {
          const res = await fetch("/api/chats", { signal: ctrl.signal });
          if (!res.ok) return;
          setChats(((await res.json()) as ChatRow[]).slice(0, 8));
          setHits([]);
          setResultsFor("");
          return;
        }
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { chats: ChatRow[]; messages: MessageHit[] };
        setChats(body.chats);
        setHits(body.messages);
        setResultsFor(q);
      } catch {
        /* aborted or offline — the groups simply keep their last rows */
      }
    }, q ? 200 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, query]);

  function run(fn: () => void) {
    setOpen(false);
    fn();
  }

  /** The day a chat or a message belongs to — the same slot and the same shape in
   *  both groups, so one column reads as one kind of fact. */
  function dayMonth(iso: string) {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(iso));
  }

  /** Tab on a typed query: start a fresh chat that already holds those words. The
   *  search field is often where the thought was actually formed, and retyping it
   *  into the composer is the step this removes. */
  function startChatWithQuery() {
    const text = query.trim();
    const id = nanoid();
    try {
      localStorage.setItem(DRAFT_PREFIX + id, text);
    } catch {
      /* private mode or a full store — the chat still opens, just empty */
    }
    run(() => router.push(`/chat/${id}`));
  }

  // The server has answered THIS query and found neither a chat nor a message.
  // Comparing against the query the results belong to is what keeps the sentence
  // from appearing over stale results mid-typing.
  const trimmed = query.trim();
  const searchedEmpty =
    trimmed.length >= MIN_SEARCH && resultsFor === trimmed && chats.length === 0 && hits.length === 0;

  function cycleTheme() {
    const order = ["system", "light", "dark"] as const;
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        // Closing forgets the search, results included — reopening should be the
        // recents list, not a moment of last week's hits under a live heading.
        if (!v) {
          setQuery("");
          setHits([]);
          setResultsFor("");
        }
      }}
    >
      <CommandInput
        placeholder={t("search")}
        value={query}
        onValueChange={setQuery}
        onKeyDown={(e) => {
          // Only a bare Tab, and only with something typed: otherwise Tab stays
          // the browser's own focus move, which is how the footer's hints and the
          // list are reached by keyboard.
          if (e.key !== "Tab" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || !query.trim()) return;
          e.preventDefault();
          startChatWithQuery();
        }}
      />
      <CommandList>
        {/* cmdk counts only the rows it owns, and the message rows are force-mounted
            — so it has to be told when the list is not actually empty. And when the
            search itself has a sentence to say, two "nothing here" lines for one
            empty search is one too many. */}
        {hits.length === 0 && !searchedEmpty && <CommandEmpty>{t("noResults")}</CommandEmpty>}

        {searchedEmpty && (
          <CommandGroup forceMount>
            <CommandItem disabled forceMount>
              <Search />
              {t("noSearchHits")}
            </CommandItem>
          </CommandGroup>
        )}

        {chats.length > 0 && (
          <CommandGroup heading={query.trim() ? t("groups.chats") : t("groups.recentChats")}>
            {chats.map((c) => (
              <CommandItem
                key={c.id}
                // cmdk matches on `value`; the title is what the server matched on
                // too, so a server hit is never filtered back out. The id keeps two
                // same-titled chats distinct.
                value={`${c.title ?? ""} ${c.id}`}
                onSelect={() => run(() => router.push(`/chat/${c.id}`))}
              >
                <MessageSquare />
                <span className="truncate">{c.title || tRoot("nav.newChat")}</span>
                {/* What tells two same-titled chats apart: the project it lives in,
                    or failing that the day it was last touched — the same slot the
                    settings rows use for their page name. */}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {c.projectName || (c.updatedAt && dayMonth(c.updatedAt))}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hits.length > 0 && (
          // `forceMount`, group and rows: these came back ranked — a whole-word
          // match above a substring one, at most three per chat — and cmdk's own
          // filter both re-scores and REORDERS the rows it owns, which would
          // silently replace that ranking with a fuzzy score over a snippet. Force
          // -mounted rows are left in the order they arrived, and stay arrow-key
          // reachable (cmdk walks the DOM for that).
          <CommandGroup heading={t("groups.messages")} forceMount>
            {hits.map((h) => (
              <CommandItem
                key={h.messageId}
                forceMount
                value={h.messageId}
                className="h-auto items-start py-2"
                onSelect={() => run(() => router.push(`/chat/${h.chatId}?m=${h.messageId}`))}
              >
                {h.role === "user" ? <User className="mt-0.5" /> : <Bot className="mt-0.5" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-muted-foreground">
                    {h.chatTitle || tRoot("nav.newChat")}
                  </span>
                  <span className="block truncate">{highlightSnippet(h.snippet)}</span>
                </span>
                <span className="shrink-0 self-start text-xs text-muted-foreground">{dayMonth(h.createdAt)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

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
      <div className="flex items-center gap-4 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><CommandKbd>↑↓</CommandKbd>{t("hints.navigate")}</span>
        <span className="flex items-center gap-1.5"><CommandKbd>↵</CommandKbd>{t("hints.open")}</span>
        {/* Named only once there is text to carry over, so the resting palette
            keeps its three keys. */}
        {trimmed && (
          <span className="flex items-center gap-1.5"><CommandKbd>tab</CommandKbd>{t("hints.newChatWith")}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5"><CommandKbd>esc</CommandKbd>{t("hints.close")}</span>
      </div>
    </CommandDialog>
  );
}
