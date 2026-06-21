import { SidebarTrigger } from "@/components/ui/sidebar";

export function Header({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 items-center gap-2 px-4 pl-[max(1rem,env(safe-area-inset-left))]">
      {/* On mobile the sidebar is an off-canvas sheet with no always-visible
          handle, so every page header carries the trigger to open it. Hidden
          on md+ where the sidebar is docked. */}
      <SidebarTrigger className="-ml-1 size-9 md:hidden" />
      {children}
      {title && <h1 className="text-base font-medium">{title}</h1>}
    </header>
  );
}
