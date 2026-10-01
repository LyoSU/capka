"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

/** The panel reveals with the app's one disclosure grammar (globals.css): a
 *  one-row grid whose track goes 0fr → 1fr while its contents fade, so nothing
 *  is measured. The track needs exactly one child that can shrink below its
 *  content, hence the clip wrapper; the caller's `className` styles the box
 *  INSIDE it, so padding and borders collapse with the track instead of
 *  leaving a sliver behind. */
function CollapsibleContent({ className, children, ...props }: Omit<CollapsiblePrimitive.Panel.Props, "className"> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props}>
      <div data-slot="collapsible-clip">
        {className ? <div className={className}>{children}</div> : children}
      </div>
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
