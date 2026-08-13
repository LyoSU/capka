"use client";

import { ArrowDown } from "lucide-react";
import { haptic } from "@/lib/haptics";
import type { JumpTone } from "./use-chat-scroll";

/**
 * "Back to the end of the conversation", floating over the foot of the transcript.
 *
 * WHAT IT MEANS. It appears when the reader is away from the end — nothing else. The
 * affordance it replaces asked a different question ("is there content below the
 * fold?"), which was true for most of every streaming turn, so it sat on screen
 * almost permanently and told nobody anything.
 *
 * WHY THREE TONES. The plain arrow is the whole affordance most of the time, and
 * anything more would be decoration. But a reader who has scrolled away from a turn
 * that is STILL being written wants to know that, and a turn that arrived on its own
 * (from Telegram, from an automation) has to announce itself in words — pulling the
 * screen to it would be the wrong answer to "something happened". So the pill grows
 * exactly as much as the situation earns:
 *
 *   idle  ·  a 36px circle with an arrow
 *   live  ·  the same circle, plus one small pulsing dot
 *   new   ·  a labelled pill, because "new message" is a sentence, not an icon
 */
export function JumpPill({
  show,
  tone,
  bottom,
  onClick,
  label,
  newLabel,
}: {
  show: boolean;
  tone: JumpTone;
  /** Room the footer occupies, so the pill rests just on top of it. The same
   *  measurement the scroll area reserves, lifted by the keyboard inset alongside
   *  the composer it belongs to. */
  bottom: number;
  onClick: () => void;
  label: string;
  newLabel: string;
}) {
  const isNew = tone === "new";
  return (
    <div
      className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
      style={{ bottom: `calc(${bottom + 4}px + var(--kb, 0px))` }}
    >
      {/* Announced politely, and ONLY for a turn that arrived on its own. The live
          region is deliberately not wrapped around the whole pill: the `live` tone
          changes with every streamed delta, and a region covering it would narrate
          the same nothing over and over. A reader who scrolled away from their own
          turn already knows it is running. */}
      <span aria-live="polite" className="sr-only">{isNew ? newLabel : ""}</span>
      <button
        type="button"
        onClick={() => { haptic("tap"); onClick(); }}
        tabIndex={show ? 0 : -1}
        aria-hidden={!show}
        aria-label={isNew ? newLabel : label}
        // Entrance and exit are the same transition rather than an animation, so
        // dismissing it is as considered as its arrival. Scale + 2px is the `pop-in`
        // register the artifact tiles use — an object arriving, not a panel sliding —
        // and `--ease-out` is the app's single entrance curve. The global
        // reduced-motion reset flattens all of it to instant.
        //
        // `before:` is the touch target, not the visible shape: the circle reads
        // best at 36px, and a 36px tap target is under the 44px floor every mobile
        // guideline sets. The pseudo-element grows the hit area without growing the
        // object — the standard way to keep those two independent.
        className={`relative inline-flex items-center gap-1.5 rounded-full bg-card text-sm text-foreground shadow-raised ring-1 ring-border/60 transition-[opacity,transform,box-shadow] duration-200 [transition-timing-function:var(--ease-out)] before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] [@media(hover:hover)]:hover:ring-border ${
          isNew ? "h-9 px-3.5" : "size-9 justify-center"
        } ${show ? "pointer-events-auto scale-100 opacity-100" : "translate-y-0.5 scale-90 opacity-0"}`}
      >
        {isNew && <span className="whitespace-nowrap font-medium">{newLabel}</span>}
        <span className="relative grid place-items-center">
          <ArrowDown className="h-4 w-4" />
          {tone === "live" && (
            // Anchored to the glyph, not the button, so it reads as "this arrow
            // leads to something happening" rather than as a notification badge
            // bolted onto a control. One dot, one colour, no ring: the pulse is
            // already the whole message.
            <span
              aria-hidden
              className="animate-pulse-fast absolute -right-2 -top-2 size-1.5 rounded-full bg-primary"
            />
          )}
        </span>
      </button>
    </div>
  );
}
