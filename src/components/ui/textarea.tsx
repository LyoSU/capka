import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // `bg-field`, matching Input. These two were `bg-field` and
        // `bg-transparent` respectively, so a one-line answer and a multi-line one
        // sat on different surfaces in the same form. The dark-mode `bg-input/30`
        // that used to paper over the transparency goes with it — `--field` has
        // its own dark value.
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-field px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
