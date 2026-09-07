import { cva, type VariantProps } from "class-variance-authority"

/**
 * Pure class-variance-authority config for buttons.
 *
 * Lives in its own module WITHOUT "use client" so it can be called from both
 * server and client components. The `Button` component (button.tsx) is client-only,
 * but its variant string-builder is just a pure function — keeping it here lets
 * server components (e.g. not-found.tsx) call `buttonVariants()` without crossing
 * the RSC boundary.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-micro outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 [a]:hover:bg-primary/80",
        // The visible edge comes from `shadow-btn`, not `border-*`: the base class
        // keeps a 1px transparent border so the box model is unchanged, and the
        // shadow token paints the hairline — one property for the whole rung, and
        // the same edge every other raised control in the app uses. The old
        // `dark:` overrides are gone because `--hover` is now theme-aware.
        outline:
          "bg-background shadow-btn hover:bg-hover hover:text-foreground aria-expanded:bg-hover-strong aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-hover-strong aria-expanded:bg-hover-strong aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-hover hover:text-foreground aria-expanded:bg-hover-strong aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // The control rungs of the app-wide scale (globals.css). The old sm/xs
      // radius was `min(var(--radius-md), 10px|12px)`, and with --radius at
      // 0.7rem both clamps always resolved to --radius-md itself — so they are
      // plain `rounded-md` now, same pixels, one fewer number to keep in sync.
      // `sm` no longer restates the type size or the icon size either: text-sm
      // and size-4 already come from the base, and the old text-[0.8rem] was
      // the only off-ladder step in the app.
      size: {
        default:
          "h-9 gap-2 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 rounded-md px-2.5 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-10 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { buttonVariants }
export type ButtonVariants = VariantProps<typeof buttonVariants>
