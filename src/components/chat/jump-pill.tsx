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
   *  measurement the scroll area reserves. The keyboard inset is NOT folded in
   *  here — see the transform below. */
  bottom: number;
  onClick: () => void;
  label: string;
  newLabel: string;
}) {
  const isNew = tone === "new";
  return (
    <div
      // The keyboard inset rides the same property, duration and curve as the
      // footer this pill rests on (`transition-transform duration-200 ease-out`
      // there), so the two move as one object. It used to be added into `bottom`,
      // which nothing transitions: the inset changed in a single frame while the
      // composer glided over 200ms, so CLOSING the keyboard dropped the pill the
      // whole inset at once and it landed inside the composer card until the
      // glide caught up. Measured in a harness at a 300px inset: the 36px gap
      // became −264px on the first frame and recovered by ~60ms. Centring moves
      // into the same transform because a `-translate-x-1/2` class beside an
      // inline transform is simply overwritten.
      // No motion-reduce opt-out here on purpose: the global reset in globals.css
      // flattens every transition to 0.01ms, so this and the footer go instant
      // together. An opt-out on one of the two is how they would desync.
      className="pointer-events-none absolute left-1/2 z-10 transition-transform duration-200 ease-out"
      style={{
        bottom: `${bottom + 4}px`,
        transform: "translate(-50%, calc(-1 * var(--kb, 0px)))",
      }}
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
          <ArrowDown className="size-4" />
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
