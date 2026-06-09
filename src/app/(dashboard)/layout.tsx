import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { ProviderStatusBanner } from "@/components/layout/provider-status-banner";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <ProviderStatusBanner />
        {children}
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  );
}
