/**
 * unClaw's three-claw mark, mirroring `public/icon.svg` as three tapered blades
 * that fill with `currentColor` — wide at the top, sharp at the tip. Used as the
 * brand badge and, scaled up at low element-opacity, as the calm background
 * monogram on auth / setup surfaces.
 *
 * Each blade is a closed path: down the outer edge to the tip, back up the inner
 * edge. Tracing the silhouette as a few béziers (rather than embedding the
 * icon's verbose point clouds) keeps the source legible and the shape crisp.
 *
 * `animated` wipes the blades in from top to tip on mount (see `.claw-reveal`
 * in globals.css), staggered so the claw reads as drawing itself in.
 */
export function ClawMark({ className, animated }: { className?: string; animated?: boolean }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="currentColor"
      className={animated ? `claw-reveal ${className ?? ""}` : className}
      aria-hidden
    >
      <path d="M176 150 Q182 260 216 366 Q210 250 203 150 Z" />
      <path d="M241 134 Q246 258 256 382 Q266 258 270 134 Z" />
      <path d="M336 150 Q330 260 296 366 Q302 250 309 150 Z" />
    </svg>
  );
}
