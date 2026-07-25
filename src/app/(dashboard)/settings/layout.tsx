"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Settings, Link2, Puzzle, Brain, Users, BarChart3, Sparkles, Wallet, Lock, Download, CalendarClock, ScrollText, Bot, Search } from "lucide-react";
import { Header } from "@/components/layout/header";
import { SETTINGS_DIRECTORY, searchSettings } from "@/lib/settings-directory";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useBilling } from "@/hooks/use-billing";

type NavItem = { key: string; href: string; icon: typeof Settings; adminOnly?: boolean };
type NavSection = { titleKey: string; items: NavItem[] };

const navSections: NavSection[] = [
  {
    titleKey: "personal",
    items: [
      { key: "general", href: "/settings", icon: Settings },
      // Connections is personal (each user's own provider keys). Visibility is
      // mode-gated below: hidden only when the instance forbids own keys.
      { key: "connections", href: "/settings/connections", icon: Link2 },
      { key: "memory", href: "/settings/memory", icon: Brain },
      { key: "skills", href: "/settings/skills", icon: Sparkles },
      { key: "automations", href: "/settings/automations", icon: CalendarClock },
    ],
  },
  {
    titleKey: "admin",
    items: [
      // Ordered by how often an admin actually goes there: what the agent is, who
      // may use it, what it costs — then the perimeter and the read-only views.
      { key: "agent", href: "/settings/agent", icon: Bot, adminOnly: true },
      // People absorbed the old Authentication page as a tab; Permissions became a
      // tab of Extensions. Both old paths still resolve, as redirects.
      { key: "people", href: "/settings/users", icon: Users, adminOnly: true },
      { key: "billing", href: "/settings/billing", icon: Wallet, adminOnly: true },
      { key: "integrations", href: "/settings/integrations", icon: Puzzle, adminOnly: true },
      { key: "security", href: "/settings/security", icon: Lock, adminOnly: true },
      { key: "usage", href: "/settings/usage", icon: BarChart3, adminOnly: true },
      { key: "activity", href: "/settings/activity", icon: ScrollText, adminOnly: true },
      { key: "updates", href: "/settings/updates", icon: Download, adminOnly: true },
    ],
  },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations("settings");
  // Root-namespaced, for the search index: its entries name full key paths so a
  // result reads the same words as the page it links to, wherever that page's
  // messages happen to live.
  const tRoot = useTranslations();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const [query, setQuery] = useState("");
  // Which result Enter would open. Reset whenever the query changes, so a
  // half-typed word can never fire off the previous query's top hit.
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const { billing } = useBilling();
  // Non-admins see Connections only when the instance lets them bring their own
  // key; admins always need it (they configure the shared key there).
  const showConnections = isAdmin || (billing?.ownKeysAllowed ?? false);

  const isVisible = (item: NavItem) => {
    if (item.key === "connections") return showConnections;
    return !item.adminOnly || isAdmin;
  };

  const isActiveItem = (href: string) =>
    href === "/settings" ? pathname === "/settings" : pathname.startsWith(href);

  // Sections with at least one visible item. Non-admins lose the entire admin
  // section, so its header should disappear too.
  const visibleSections = navSections
    .map((section) => ({ ...section, items: section.items.filter(isVisible) }))
    .filter((section) => section.items.length > 0);

  const flatItems = visibleSections.flatMap((section) => section.items);

  // Search results replace the nav rather than floating over it: the nav IS the
  // list of places, so swapping its contents keeps one thing on screen to read
  // instead of two competing ones — and it works identically on mobile, where an
  // overlay dropdown over horizontal tabs would have nowhere to go.
  const searching = query.trim().length > 0;
  const results = searching
    ? searchSettings(
        SETTINGS_DIRECTORY.filter((e) => (!e.adminOnly || isAdmin) && (e.href !== "/settings/connections" || showConnections)),
        query,
        tRoot,
      )
    : [];

  // No keyboard shortcut here on purpose. ⌘K already belongs to the global command
  // palette, which now lists every setting itself (see command-palette.tsx) — a
  // second handler on the same chord inside settings would shadow it, and two
  // search surfaces for one list is one too many. This box is the filter you reach
  // for once you are already on the page.

  // Keyboard is the whole point of a search box: reaching for the mouse to pick a
  // result costs exactly what the search was meant to save.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return setQuery("");
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      router.push(results[Math.min(active, results.length - 1)].href);
      setQuery("");
      searchRef.current?.blur();
    }
  };

  const renderSearch = (attachRef: boolean) => (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        // Only the desktop copy holds the ref: both are always in the DOM (one is
        // hidden by CSS), and Cmd+K focusing a display:none input does nothing.
        ref={attachRef ? searchRef : undefined}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onSearchKey}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
        className="w-full rounded-md border bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );

  const resultList = (
    <div className="flex flex-col gap-0.5">
      {results.length === 0 ? (
        <p className="px-2.5 py-2 text-sm text-muted-foreground">{t("searchEmpty")}</p>
      ) : (
        results.map((entry, i) => (
          <Link
            key={`${entry.href}-${entry.label}`}
            href={entry.href}
            onClick={() => setQuery("")}
            onMouseEnter={() => setActive(i)}
            className={cn(
              "flex flex-col rounded-md px-2.5 py-1.5 transition-colors",
              i === active ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <span className="text-sm">{tRoot(entry.label)}</span>
            <span className="text-xs text-muted-foreground">{tRoot(entry.page)}</span>
          </Link>
        ))
      )}
    </div>
  );

  return (
    <>
      <Header title={t("title")} />
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Mobile: search above flat horizontal scroll tabs (headers don't fit a
            single row); results take the tabs' place as a vertical list. */}
        <div className="border-b px-3 py-2 md:hidden">
          {renderSearch(false)}
          {searching && <div className="pt-2">{resultList}</div>}
        </div>
        <nav className={cn("flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden", searching && "hidden")}>
          {flatItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                isActiveItem(item.href)
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
              {t(`nav.${item.key}`)}
            </Link>
          ))}
        </nav>
        {/* Desktop: vertical sidebar, grouped by section */}
        <nav className="hidden w-56 flex-col gap-4 border-r p-3 md:flex">
          {renderSearch(true)}
          {searching && resultList}
          {!searching && visibleSections.map((section) => (
            <div key={section.titleKey} className="flex flex-col gap-1">
              <p className="px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t(`nav.sections.${section.titleKey}`)}
              </p>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    isActiveItem(item.href)
                      ? "bg-accent font-medium"
                      : "text-muted-foreground hover:bg-accent/50"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {t(`nav.${item.key}`)}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto p-4 md:p-6 [scrollbar-gutter:stable]">{children}</div>
      </div>
    </>
  );
}
