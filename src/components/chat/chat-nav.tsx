"use client";

import { useEffect, useRef, useState } from "react";

// A right-edge "minimap" of the conversation: one pill per user turn, collapsed
// to a thin rail and expanding into a jump list. Lets you skim a long chat and
// leap to any of your own messages. Desktop only (touch devices scroll directly),
// but fully keyboard-operable: the rail is a real button reachable by Tab that
// opens the list on Enter/click; hover opens it for mouse users; Escape closes
// and returns focus to the rail; moving focus out of the nav closes it. Without
// this a keyboard user could never reach the jump list (WCAG 2.1 AA).

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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Opening with Enter used to leave focus on the trigger, which the same click
  // turns `opacity-0 pointer-events-none` — the focus ring simply vanished and
  // the user had to Tab blindly through the list. Keyed on `open` alone, so a
  // mouse hover (which never sets it) can't steal focus from what you're typing.
  useEffect(() => {
    if (!open) return;
    const at = items.findIndex((it) => it.id === activeId);
    itemRefs.current[at >= 0 ? at : 0]?.focus();
  }, [open, items, activeId]);

  // Not worth the clutter for a single turn.
  if (items.length < 2) return null;

  return (
    <div
      className="group absolute right-6 top-1/2 z-20 hidden -translate-y-1/2 md:block"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
          return;
        }
        // A jump list is navigated with arrows, not by tabbing through every
        // turn of a long conversation.
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const at = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        e.preventDefault();
        const next = e.key === "ArrowDown" ? at + 1 : at - 1;
        itemRefs.current[(next + items.length) % items.length]?.focus();
      }}
      // Close once focus leaves the whole nav (keyboard tab-out); staying within
      // it (rail → list items) keeps it open.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {/* Collapsed rail — one pill per turn, the active one longer and darker.
          It's the trigger: a real button, so Tab reaches it and Enter opens the
          list. Hidden (but still focusable) once the list is open or on hover. */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex max-h-[70vh] flex-col items-end gap-2 overflow-hidden rounded-lg py-2 outline-none transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-ring ${
          open ? "pointer-events-none opacity-0" : "group-hover:pointer-events-none group-hover:opacity-0"
        }`}
      >
        {items.map((it) => (
          <span
            key={it.id}
            // /25 put these 6px indicators far below the 3:1 that non-text UI
            // needs, so the collapsed rail's only "where am I" cue was invisible
            // to low-vision users. Position now reads from width AND weight.
            className={`h-1.5 rounded-full transition-[width,background-color] duration-150 ${
              it.id === activeId ? "w-6 bg-foreground" : "w-3 bg-foreground/45"
            }`}
          />
        ))}
      </button>

      {/* Expanded — a clean jump list of the user's messages. Visible on hover
          (mouse) or when `open` (keyboard). Kept `invisible` while closed so its
          buttons stay out of the tab order until the list is actually shown. */}
      <nav
        aria-label={label}
        className={`absolute right-0 top-1/2 flex max-h-[70vh] w-80 max-w-[60vw] -translate-y-1/2 flex-col gap-0.5 overflow-y-auto rounded-2xl border border-border/60 bg-popover p-2.5 shadow-xl transition-opacity duration-150 ${
          open ? "visible opacity-100" : "invisible opacity-0 group-hover:visible group-hover:opacity-100"
        }`}
      >
        {items.map((it, i) => {
          const active = it.id === activeId;
          return (
            <button
              key={it.id}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              onClick={() => {
                onJump(it.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                active ? "bg-muted" : "hover:bg-muted/60"
              }`}
            >
              <span
                className={`h-1.5 shrink-0 rounded-full transition-[width,background-color] ${
                  active ? "w-5 bg-foreground" : "w-3 bg-foreground/45"
                }`}
              />
              <span className={`truncate text-sm ${active ? "text-foreground" : "text-muted-foreground"}`}>
                {it.text || "…"}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
