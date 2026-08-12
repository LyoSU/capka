import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // Flat: tone + a 1px border, and the focus ring for state. There used to
        // be an inset shadow here too, which was a third statement of a fact the
        // border and the ring already make — and its sunken look is what made a
        // read-only chip elsewhere in the app read as an editable field.
        //
        // `bg-field`, and it has to be. A field turns up on FOUR host surfaces, and
        // `--field` (0.955) is the only value that stays on one side — darker — of
        // every one of them: page 0.97, sidebar 0.985, card and popover both 0.995.
        // `--card` looks like the tidier choice until you notice `--popover` is the
        // very same value, so a field in a dialog or a popover would have no fill of
        // its own at all and nothing but a 1.33:1 border to define it. That `--field`
        // manages all four is not luck: in the dark theme it is alpha
        // (`oklch(0 0 0 / 0.18)`) precisely so it darkens whatever it lands on.
        //
        // It is a quiet step: 1.12:1 inside a card, 1.05:1 on the page. If a field
        // still reads as too dark, the lever is `--field` itself in globals.css, not
        // this class — swapping the class here only moves the problem into dialogs.
        "h-8 w-full min-w-0 rounded-lg border border-input bg-field px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
