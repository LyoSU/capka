export function Header({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 items-center gap-2 border-b px-4">
      {children}
      {title && <h1 className="text-base font-medium">{title}</h1>}
    </header>
  );
}
