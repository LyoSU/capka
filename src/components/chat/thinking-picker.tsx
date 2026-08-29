"use client";

import { useId, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { availableAmounts, clampAmount, type ThinkAmount } from "@/lib/models/thinking";
import { haptic } from "@/lib/haptics";

/** Knob diameter in px — equal to the track height (`h-7`/`size-7`) so the knob
 *  covers the track fully instead of sinking into it and leaving a sliver of fill
 *  above and below. The drawn knob, the invisible native thumb, the fill's end and
 *  the stop dots are all positioned against this, so it must be one constant. */
const THUMB = 28;

interface ThinkingPickerProps {
  value: ThinkAmount;
  onChange: (value: ThinkAmount) => void;
  /** The owning connection's provider (openrouter / litellm / anthropic …) — decides
   *  whether there's a reasoning knob at all and what shape it takes. Undefined
   *  while the model list is still settling, which renders nothing. */
  provider?: string;
  /** Whether the model reasons. `null`/undefined = unknown (an off-catalog id from
   *  a custom endpoint): we don't hide the control on a guess, since every stop is
   *  safe — see the enum negotiation in the runner. `false` = known not to. */
  reasoning?: boolean | null;
  /** The effort values this model is known to accept, learned server-side. Absent
   *  until the first negotiation; the stops then narrow to exactly these. */
  efforts?: string[] | null;
  disabled?: boolean;
  /**
   * Render the control on its own, with no pill trigger and no popover — for hosts
   * that already provide the surface. Used by the model overlay on phones, where the
   * composer has no room for a second control and stacking a popover on top of a
   * full-screen overlay would be two surfaces for one decision.
   */
  inline?: boolean;
}

/**
 * Chooses how hard the model should think, in plain words rather than a provider's
 * `reasoning_effort` enum.
 *
 * Two rules make this safe for a non-technical user:
 *  - it renders ONLY when the chosen model actually has a reasoning knob with
 *    more than one setting (otherwise there is nothing honest to offer), and
 *  - the stops come from what that model accepts, so an illegal value can't be
 *    picked in the first place — the runner's negotiation is the safety net, not
 *    the mechanism.
 */
export function ThinkingPicker({ value, onChange, provider, reasoning, efforts, disabled, inline }: ThinkingPickerProps) {
  const t = useTranslations("chat.thinking");
  const labelId = useId();

  const stops = useMemo(
    () => (provider && reasoning !== false ? availableAmounts(provider, efforts) : []),
    [provider, reasoning, efforts],
  );
  // A single stop is not a choice, and no stops means this model has no knob.
  if (stops.length < 2) return null;

  const current = clampAmount(value, stops);
  const index = stops.indexOf(current);
  const max = stops.length - 1;
  const atMax = index === max;

  const select = (next: ThinkAmount) => {
    if (next === current) return;
    haptic("tap");
    onChange(next);
  };
  // Where the thumb's centre sits for a given stop. A native range insets the
  // thumb by half its width at each end, so the fill and the dots have to use the
  // same geometry or they drift out of alignment with it.
  const fraction = (i: number) => (max === 0 ? 0 : i / max);
  const centre = (i: number) => `calc(${THUMB / 2}px + ${fraction(i)} * (100% - ${THUMB}px))`;
  // The fill runs to the thumb's TRAILING edge, not its centre: ending at the
  // centre leaves the thumb's right half sitting on empty track, which reads as a
  // seam between the bar and the knob. Overshooting by the same half-thumb keeps
  // them visually joined at any zoom, and the thumb hides the fill's rounded cap.
  const fillTo = (i: number) => `calc(${THUMB}px + ${fraction(i)} * (100% - ${THUMB}px))`;

  // The control itself — label row, faster/smarter hints, slider, and the
  // per-stop explanation. Extracted so it can render either inside the popover
  // (desktop, anchored to the pill) or inline with no popover at all, which is what
  // the phone needs: on a narrow screen the pill lives inside the model overlay, and
  // a popover opened on top of a full-screen overlay is a stack of two surfaces for
  // one decision.
  const control = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-sm text-muted-foreground">
          {t("label")}
        </span>
        <span className={`text-sm font-medium transition-colors ${atMax ? "text-foreground" : "text-foreground/80"}`}>
          {t(`amount.${current}`)}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] leading-none text-muted-foreground">
        <span>{t("faster")}</span>
        <span>{t("smarter")}</span>
      </div>

      {/* A native range input does the hard parts for free — drag, touch,
          arrow/Home/End keys, and the slider a11y role. Its own thumb is made
          invisible and a div is drawn in its place: a native thumb's position
          can't be transitioned, so it TELEPORTS while the fill glides, and the
          two visibly desync on a click-to-jump. One shared easing on both, and
          they move as a single object. */}
      <div className="group/track relative mt-2 h-7">
        <div className="absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 rounded-full bg-muted" />
        {/* Fill runs under the knob (see fillTo) so there's no seam between them.
            Deepest stop deepens it — the one bit of emphasis, no accent colour:
            this palette is deliberately calm and a saturated gradient here would
            read as another product. */}
        <div
          className={`absolute left-0 top-1/2 h-7 -translate-y-1/2 rounded-full transition-[width,background-color] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none ${
            atMax ? "bg-foreground/20" : "bg-foreground/10"
          }`}
          style={{ width: fillTo(index) }}
        />
        {/* Dots mark the real stops. The one under the knob is hidden — the knob
            itself stands in for it. */}
        {stops.map((s, i) => (
          <span
            key={s}
            aria-hidden
            className={`pointer-events-none absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity ${
              i === index ? "opacity-0" : i < index ? "bg-foreground/40" : "bg-foreground/25"
            }`}
            style={{ left: centre(i) }}
          />
        ))}
        {/* The knob. Full track height, so no sliver of fill shows above or
            below it and the fill's rounded cap stays hidden underneath. Presses
            in slightly while dragging — the only motion here that isn't just
            position. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card shadow-btn transition-[left,transform] duration-200 ease-[var(--ease-out)] group-active/track:scale-95 motion-reduce:transition-none"
          style={{ left: centre(index) }}
        />
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={index}
          disabled={disabled}
          onChange={(e) => select(stops[Number(e.target.value)])}
          aria-labelledby={labelId}
          aria-valuetext={t(`amount.${current}`)}
          // The native thumb is kept at the drawn knob's exact size but made
          // invisible: its size is what sets the track's end insets, so the two
          // must agree or the drag lands off the knob.
          className="absolute inset-0 h-7 w-full cursor-grab appearance-none rounded-full bg-transparent outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover [&::-moz-range-thumb]:size-7 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:size-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-transparent"
        />
      </div>

      {/* Same one-cell grid as the trigger label, for the same reason: the
          hints wrap to different line counts, and the popup is anchored above
          the pill — so a taller hint grows the popup UPWARD and the whole thing
          jumps mid-drag. Stacking them reserves the tallest one's height, and
          it stays correct in every locale (a min-height in px would not). */}
      <div className="mt-3 grid text-xs leading-snug text-muted-foreground">
        {stops.map((s) => (
          <p
            key={s}
            aria-hidden={s !== current}
            className={`col-start-1 row-start-1 ${s === current ? "" : "invisible"}`}
          >
            {t(`hint.${s}`)}
          </p>
        ))}
      </div>
    </>
  );

  // Inline: no trigger, no popover — the caller has already given it a place.
  if (inline) return <div className="w-full">{control}</div>;

  return (
    <>
      {/* Hairline against the model pill it shares a shell with. Lives here, not
          in the composer, so it disappears together with the control. */}
      <span aria-hidden className="mr-0.5 h-4 w-px shrink-0 bg-border" />
      <Popover>
        <PopoverTrigger
          disabled={disabled}
          aria-label={`${t("label")}: ${t(`amount.${current}`)}`}
          className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 data-popup-open:text-foreground"
        >
          {/* The glyph carries the meaning at a glance: bars that grow with depth.
              aria-hidden — the trigger's own label already says it in words. */}
          <span aria-hidden className="flex items-end gap-[2px]">
            {stops.slice(1).map((_, i) => (
              <span
                key={i}
                className={`w-[3px] rounded-full transition-[height,background-color] duration-200 ${
                  i < index ? "bg-current" : "bg-current/25"
                }`}
                style={{ height: `${5 + i * 3}px` }}
              />
            ))}
          </span>
          {/* All labels occupy ONE grid cell, so the slot is as wide as the longest
              one and the pill never changes width. Without this, dragging the
              slider re-lays-out the whole pill (and, since it's centred, shifts the
              model name and this popover sideways on every step).
              The cost is that the slot always reserves the worst case (the longest
              label in the active locale), which is fine everywhere it renders: the
              greeting gives the pill a row of its own, and the chat header on a phone
              uses the compact model trigger instead, with this control living inside
              its overlay. */}
          <span className="grid">
            {stops.map((s) => (
              <span
                key={s}
                aria-hidden={s !== current}
                className={`col-start-1 row-start-1 font-medium ${s === current ? "" : "invisible"}`}
              >
                {t(`amount.${s}`)}
              </span>
            ))}
          </span>
        </PopoverTrigger>

        {/* Desktop: the same `control`, anchored above the pill. */}
        <PopoverContent side="top" align="end" className="w-64 p-3.5">
          {control}
        </PopoverContent>
      </Popover>
    </>
  );
}
