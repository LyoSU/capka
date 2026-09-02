"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

  // One highlight for the whole list, gliding between rows, instead of a fill per
  // row that lights up and goes out. It rests on the active turn and follows the
  // pointer — or keyboard focus, which gets the same treatment — then glides back
  // when they leave. A single element moving says "the same thing moved"; two
  // backgrounds toggling reads as two unrelated events. Measured after commit
  // from the row's own box, so the list's padding and gaps never appear here as
  // numbers. Reduced motion collapses the transition through the global reset.
  const [hot, setHot] = useState<number | null>(null);
  const activeIndex = items.findIndex((it) => it.id === activeId);
  const target = hot ?? (activeIndex >= 0 ? activeIndex : null);
  const [glide, setGlide] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = target == null ? null : itemRefs.current[target];
    setGlide(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
  }, [target, items]);

  // Opening with Enter used to leave focus on the trigger, which the same click
  // turns `opacity-0 pointer-events-none` — the focus ring simply vanished and
  // the user had to Tab blindly through the list. Keyed on `open` alone, so a
  // mouse hover (which never sets it) can't steal focus from what you're typing.
  useEffect(() => {
    if (!open) return;
    const at = items.findIndex((it) => it.id === activeId);
    itemRefs.current[at >= 0 ? at : 0]?.focus();
  }, [open, items, activeId]);

  // A minimap earns its place only once a conversation is long enough to be worth
  // skimming. At the old threshold of 2 it appeared as two unlabelled marks
  // floating at the edge of a nearly empty screen: no skimming to do, nothing to
  // say what they were, and an unexplained mark reads as a rendering glitch rather
  // than as navigation. Five turns is roughly where scrolling back starts to cost
  // something.
  if (items.length < 5) return null;

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
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); setHot(null); }
      }}
      onMouseLeave={() => setHot(null)}
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
        className={`flex max-h-[70dvh] flex-col items-end gap-2 overflow-hidden rounded-lg py-2 outline-none transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-ring ${
          open ? "pointer-events-none opacity-0" : "group-hover:pointer-events-none group-hover:opacity-0"
        }`}
      >
        {items.map((it) => (
          <span
            key={it.id}
            // The inactive marks sit at exactly the floor and no higher. /25 was
            // far below the 3:1 that non-text UI needs — the rail's only "where am
            // I" cue was invisible to low-vision users — but the full
            // `--muted-foreground` that replaced it measures 6.6:1 light / 6.0:1
            // dark, which is TEXT weight: nine near-black dashes shouting from an
            // otherwise empty margin for something you read at a glance. /70
            // measures 3.3:1 light and 3.6:1 dark, so the rail reads as quiet
            // furniture and still clears the floor. Narrower too, which costs no
            // contrast and widens the gap against the active mark — position reads
            // from width first, weight second.
            className={`h-1.5 rounded-full transition-[width,background-color] duration-150 ${
              it.id === activeId ? "w-6 bg-foreground" : "w-2.5 bg-muted-foreground/70"
            }`}
          />
        ))}
      </button>

      {/* Expanded — a clean jump list of the user's messages. Visible on hover
          (mouse) or when `open` (keyboard). Kept `invisible` while closed so its
          buttons stay out of the tab order until the list is actually shown. */}
      <nav
        aria-label={label}
        className={`absolute right-0 top-1/2 flex max-h-[70dvh] w-80 max-w-[60vw] -translate-y-1/2 flex-col gap-0.5 overflow-y-auto rounded-2xl bg-popover p-2.5 shadow-overlay transition-opacity duration-150 ${
          open ? "visible opacity-100" : "invisible opacity-0 group-hover:visible group-hover:opacity-100"
        }`}
      >
        {/* The glider. First in DOM and absolutely positioned; the rows are
            `relative` so they paint above it. Stronger when resting on the active
            turn, lighter while following the pointer — the same two weights the
            rows used to carry themselves. Inset by the list's own padding so it
            spans exactly a row. */}
        <span
          aria-hidden
          className={`pointer-events-none absolute left-2.5 right-2.5 rounded-lg transition-[top,height,background-color,opacity] duration-200 [transition-timing-function:var(--ease-strong)] ${
            hot != null && hot !== activeIndex ? "bg-hover" : "bg-hover-strong"
          } ${glide ? "opacity-100" : "opacity-0"}`}
          style={glide ? { top: glide.top, height: glide.height } : undefined}
        />
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
              onMouseEnter={() => setHot(i)}
              onFocus={() => setHot(i)}
              className="relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-micro"
            >
              {/* Same weight as the rail's marks — here the row's own text already
                  says which turn it is, so the bullet is orientation, not label. */}
              <span
                className={`h-1.5 shrink-0 rounded-full transition-[width,background-color] ${
                  active ? "w-5 bg-foreground" : "w-2.5 bg-muted-foreground/70"
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
