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
        // `bg-field`, and it has to be — a field turns up on FOUR host surfaces
        // (page, sidebar, card, popover) and `--field` is the one token defined
        // against all of them. It is now the RAISED white well, not the grey one
        // it was: with `--input` at 3.30:1 the border defines the control, so the
        // old darker-than-the-page fill only competed with `disabled:bg-input/50`
        // below for the meaning "inactive". The full argument lives on the token
        // in globals.css.
        //
        // If a field still reads wrong, the lever is `--field` there, not this
        // class — swapping the class here only moves the problem into dialogs,
        // where the host surface is a different lightness.
        "h-8 w-full min-w-0 rounded-lg border border-input bg-field px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
