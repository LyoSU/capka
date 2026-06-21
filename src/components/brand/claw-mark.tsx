/**
 * unClaw's three-claw mark as a stroke glyph that inherits `currentColor`.
 * Mirrors `public/icon.svg`. Used as the brand badge and, scaled up at low
 * element-opacity, as the calm background monogram on auth / setup surfaces.
 *
 * Opacity is applied at the element level by the caller (e.g. `opacity-[0.03]`)
 * rather than via a translucent stroke color, so overlapping strokes flatten
 * into a single layer instead of darkening at their intersections.
 *
 * `animated` sketches the strokes in on mount (see `.claw-draw` in globals.css);
 * `pathLength={1}` normalizes every stroke to a single-dash length so the draw
 * keyframe works regardless of the real path geometry.
 */
export function ClawMark({ className, animated }: { className?: string; animated?: boolean }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      stroke="currentColor"
      strokeWidth={26}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={animated ? `claw-draw ${className ?? ""}` : className}
      aria-hidden
    >
      <path pathLength={1} d="M175 140 Q180 265 200 382" />
      <path pathLength={1} d="M256 120 Q256 255 256 388" />
      <path pathLength={1} d="M337 140 Q332 265 312 382" />
      <path pathLength={1} d="M160 370 Q256 420 352 370" />
    </svg>
  );
}
