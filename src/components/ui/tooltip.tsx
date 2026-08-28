"use client"

import type { ReactElement } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 400,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background shadow-overlay fill-mode-forwards has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/** Modifier tokens a `Hint` shortcut may use; rendered per the viewer's platform. */
const MODIFIERS: Record<string, [mac: string, other: string]> = {
  mod: ["⌘", "Ctrl"],
  shift: ["⇧", "Shift"],
  alt: ["⌥", "Alt"],
  enter: ["↵", "Enter"],
}

function Shortcut({ keys }: { keys: string[] }) {
  // Safe to read at render time: the popup only mounts on the client, on hover.
  const mac =
    typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform)
  return (
    <span
      data-slot="kbd"
      className="ml-0.5 inline-flex items-center gap-px bg-background/15 px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-background/80"
    >
      {keys.map((key) => MODIFIERS[key]?.[mac ? 0 : 1] ?? key).join(mac ? "" : "+")}
    </span>
  )
}

/**
 * A hover/focus explanation for a control that its icon alone doesn't explain.
 *
 * `label` is both the visible hint and the trigger's accessible name, so an
 * icon-only button needs no separate `aria-label`. For the same reason, don't
 * put a `Hint` on a control that already shows its own text — the label would
 * replace that text for screen readers (WCAG 2.5.3). A falsy `label` renders
 * the child untouched, so a hint can be conditional without branching.
 *
 * Touch devices never see it: the underlying tooltip is mouse- and focus-only.
 */
function Hint({
  label,
  keys,
  children,
  ...positioning
}: {
  label: string | false | null | undefined
  /** e.g. `["mod", "K"]` — modifier tokens render as ⌘/Ctrl per platform. */
  keys?: string[]
  children: ReactElement
} & Pick<
  TooltipPrimitive.Positioner.Props,
  "align" | "alignOffset" | "side" | "sideOffset"
>) {
  if (!label) return children

  return (
    <Tooltip>
      <TooltipTrigger aria-label={label} render={children} />
      <TooltipContent {...positioning}>
        {label}
        {keys?.length ? <Shortcut keys={keys} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint }
