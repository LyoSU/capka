import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { RouteTransition } from "@/components/layout/route-transition";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { ProviderStatusBanner } from "@/components/layout/provider-status-banner";
import { UpdateBanner } from "@/components/layout/update-banner";
import { OrgChangeBanner } from "@/components/layout/org-change-banner";
import { TimezoneSync } from "@/components/layout/timezone-sync";
import { isSetupComplete } from "@/lib/settings";
import { getAuth } from "@/lib/auth";
import { headers } from "next/headers";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Setup must finish before any dashboard route is usable. Guarding here (not
  // just at "/") closes the soft dead-end where a signed-in admin navigates
  // straight to /chat mid-wizard and lands on a no-provider-configured error.
  if (!(await isSetupComplete())) {
    redirect("/setup");
  }

  // Approval-gated registration: a signed-in but not-yet-approved account can't
  // reach the app (which would spend the shared key) — park it on /pending.
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null);
  if (session && (session.user as Record<string, unknown>).status === "pending") {
    redirect("/pending");
  }

  const t = await getTranslations("common");

  return (
    <SidebarProvider>
      {/* Keyboard users would otherwise have to tab through the entire chat
          list before reaching the page content on every navigation. */}
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-primary focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <AppSidebar />
      <SidebarInset id="main-content" tabIndex={-1} className="focus-visible:outline-none">
        <ProviderStatusBanner />
        <UpdateBanner />
        <OrgChangeBanner />
        {/* Crossfade the main pane on navigation so moving between chats /
            settings feels like an app (desktop only — see RouteTransition). The
            sidebar + banner sit outside it, staying anchored as content swaps. */}
        <RouteTransition>{children}</RouteTransition>
      </SidebarInset>
      <CommandPalette />
      <TimezoneSync />
    </SidebarProvider>
  );
}
