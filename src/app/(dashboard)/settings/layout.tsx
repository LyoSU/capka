"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Settings, Link2, Puzzle, Brain, Users, BarChart3, Sparkles, ShieldCheck, Wallet, KeyRound, Lock } from "lucide-react";
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
    ],
  },
  {
    titleKey: "admin",
    items: [
      { key: "security", href: "/settings/security", icon: Lock, adminOnly: true },
      { key: "integrations", href: "/settings/integrations", icon: Puzzle, adminOnly: true },
      { key: "authentication", href: "/settings/authentication", icon: KeyRound, adminOnly: true },
      { key: "permissions", href: "/settings/permissions", icon: ShieldCheck, adminOnly: true },
      { key: "billing", href: "/settings/billing", icon: Wallet, adminOnly: true },
      { key: "usage", href: "/settings/usage", icon: BarChart3, adminOnly: true },
      { key: "users", href: "/settings/users", icon: Users, adminOnly: true },
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
        {/* Mobile: flat horizontal scroll tabs (headers don't fit a single row) */}
        <nav className="flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden">
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
        <nav className="hidden w-48 flex-col gap-4 border-r p-3 md:flex">
          {visibleSections.map((section) => (
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
