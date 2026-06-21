// The first-run shell (brand panel + form) lives in <SetupWizard> so the brand
// panel can reflect live step progress. This layout just owns the viewport.
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background">{children}</div>;
}
