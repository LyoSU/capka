"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings, Link2, Puzzle, Brain, Users } from "lucide-react";
import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";

type NavItem = { label: string; href: string; icon: typeof Settings; adminOnly?: boolean };

const navItems: NavItem[] = [
  { label: "General", href: "/settings", icon: Settings },
  { label: "Connections", href: "/settings/connections", icon: Link2, adminOnly: true },
  { label: "Integrations", href: "/settings/integrations", icon: Puzzle, adminOnly: true },
  { label: "Memory", href: "/settings/memory", icon: Brain },
  { label: "Users", href: "/settings/users", icon: Users, adminOnly: true },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // Check if current user is admin (lightweight probe)
    fetch("/api/admin/users", { method: "GET" })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
  }, []);

  const visibleItems = navItems.filter((item) => !item.adminOnly || isAdmin);

  return (
    <>
      <Header title="Settings" />
      <div className="flex flex-1 overflow-hidden">
        <nav className="flex w-48 flex-col gap-1 border-r p-3">
          {visibleItems.map((item) => {
            const isActive =
              item.href === "/settings"
                ? pathname === "/settings"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-accent font-medium"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </>
  );
}
