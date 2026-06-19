"use client";

// A right-edge "minimap" of the conversation: one pill per user turn, collapsed
// to a thin rail and expanding on hover into a jump list. Lets you skim a long
// chat and leap to any of your own messages. Desktop/hover only — touch devices
// scroll directly.

interface NavItem {
  id: string;
  text: string;
}

export function ChatNav({
  items,
  activeId,
  onJump,
  label,
}: {
  items: NavItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  label: string;
}) {
  // Not worth the clutter for a single turn.
  if (items.length < 2) return null;

  return (
    <div className="group absolute right-6 top-1/2 z-20 hidden -translate-y-1/2 md:block">
      {/* Collapsed rail — one pill per turn, the active one longer and darker. */}
      <nav
        aria-label={label}
        className="flex max-h-[70vh] flex-col items-end gap-2 overflow-hidden py-2 transition-opacity duration-150 group-hover:pointer-events-none group-hover:opacity-0"
      >
        {items.map((it) => (
          <span
            key={it.id}
            className={`h-1.5 rounded-full transition-all ${
              it.id === activeId ? "w-6 bg-foreground/70" : "w-3 bg-foreground/25"
            }`}
          />
        ))}
      </nav>

      {/* Expanded on hover — a clean jump list of the user's messages. */}
      <div className="invisible absolute right-0 top-1/2 flex max-h-[70vh] w-80 max-w-[60vw] -translate-y-1/2 flex-col gap-0.5 overflow-y-auto rounded-2xl border border-border/60 bg-popover p-2.5 opacity-0 shadow-xl transition-opacity duration-150 group-hover:visible group-hover:opacity-100">
        {items.map((it) => {
          const active = it.id === activeId;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onJump(it.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                active ? "bg-muted" : "hover:bg-muted/60"
              }`}
            >
              <span
                className={`h-1.5 shrink-0 rounded-full transition-all ${
                  active ? "w-5 bg-foreground/70" : "w-3 bg-foreground/30"
                }`}
              />
              <span className={`truncate text-sm ${active ? "text-foreground" : "text-muted-foreground"}`}>
                {it.text || "…"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
