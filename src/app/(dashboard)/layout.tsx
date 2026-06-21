import { redirect } from "next/navigation";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { ProviderStatusBanner } from "@/components/layout/provider-status-banner";
import { TimezoneSync } from "@/components/layout/timezone-sync";
import { isSetupComplete } from "@/lib/settings";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Setup must finish before any dashboard route is usable. Guarding here (not
  // just at "/") closes the soft dead-end where a signed-in admin navigates
  // straight to /chat mid-wizard and lands on a no-provider-configured error.
  if (!(await isSetupComplete())) {
    redirect("/setup");
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <ProviderStatusBanner />
        {children}
      </SidebarInset>
      <CommandPalette />
      <TimezoneSync />
    </SidebarProvider>
  );
}
