"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Settings, Link2, Brain, Users, BarChart3, Sparkles, Wallet, Lock, Download, CalendarClock, ScrollText, Bot } from "lucide-react";
import { Header } from "@/components/layout/header";
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
  const isAdmin = useIsAdmin();
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

  return (
    <>
      <Header title={t("title")} />
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Mobile: flat horizontal scroll tabs (section headers don't fit a
            single row). No search here: the app sidebar's search button opens the
            command palette, which indexes every setting — a second field on this
            screen was the same index behind a second door. */}
        <nav className="flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden">
          {flatItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[15px] transition-micro",
                isActiveItem(item.href)
                  ? "bg-hover-strong font-medium text-foreground"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground"
              )}
            >
              <item.icon className="size-4" />
              {t(`nav.${item.key}`)}
            </Link>
          ))}
        </nav>
        {/* Desktop: vertical list, grouped by section. Same row height, radius and
            type size as the app sidebar — it IS a sidebar, one level in, and two
            navigation scales side by side read as two different products. */}
        <nav className="hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r p-3 md:flex">
          {visibleSections.map((section) => (
            <div key={section.titleKey} className="flex flex-col gap-0.5">
              <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
                {t(`nav.sections.${section.titleKey}`)}
              </p>
              {section.items.map((item) => {
                const active = isActiveItem(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[15px] transition-micro active:scale-[0.99]",
                      active
                        ? "bg-hover-strong font-medium text-foreground"
                        : "text-muted-foreground hover:bg-hover hover:text-foreground"
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    {t(`nav.${item.key}`)}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto p-4 md:px-10 md:py-8 [scrollbar-gutter:stable]">{children}</div>
      </div>
    </>
  );
}
