"use client";

/**
 * The readout that follows a pointer across a chart.
 *
 * Positioned so it can never leave its container: the offset from the left is
 * `pos` of the CHART, and the shift back is the same `pos` of the TOOLTIP. At the
 * far left that is 0 (flush left), at the far right a full -100% (flush right),
 * and in between it tracks the cursor — with the box always landing inside.
 *
 * A plain `-translate-x-1/2` looks equivalent and is not: half a 140px readout on
 * a 300px chart hangs past the edge anywhere in the first or last quarter, and an
 * absolutely positioned box hanging past the right edge widens the document,
 * which the browser answers with a scrollbar across the whole window. Clamping
 * only the outer 10% leaves the same bug in the middle.
 *
 * `pos` is 0..1 across the plot area.
 */
export function ChartTooltip({ pos, children }: { pos: number; children: React.ReactNode }) {
  const p = Math.max(0, Math.min(1, pos));
  return (
    <div
      style={{ left: `${p * 100}%`, transform: `translateX(-${p * 100}%)` }}
      className="pointer-events-none absolute -top-7 z-10 max-w-full truncate rounded-md bg-popover px-2 py-1 text-[11px] shadow-panel"
    >
      {children}
    </div>
  );
}
