import type { ReactNode } from "react";
import { ClawMark } from "@/components/brand/claw-mark";

/** Shared field styling for auth/setup forms — filled, rounded, calm. */
export const AUTH_FIELD =
  "h-11 rounded-xl border-transparent bg-muted/60 px-3.5 text-[15px] focus-visible:border-ring focus-visible:bg-card";

/**
 * The first-run / sign-in chrome: a calm claw monogram far behind, an opaque
 * centered card with the brand mark, a serif title, and a soft entrance morph.
 * Shared by login, register, and (in spirit) the setup wizard so every
 * pre-app surface reads as one product.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <ClawMark className="pointer-events-none absolute left-1/2 top-1/2 h-[165vmin] w-[165vmin] -translate-x-1/2 -translate-y-1/2 text-foreground opacity-[0.03]" />

      <div className="relative flex min-h-screen items-center justify-center px-5 py-12">
        <div className="animate-card-morph w-full max-w-md rounded-[1.75rem] border border-border/60 bg-card p-7 shadow-[0_1px_2px_oklch(0_0_0/0.05),0_28px_60px_-32px_oklch(0.2_0.01_60/0.28)] sm:p-8">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <ClawMark className="h-[22px] w-[22px]" />
            </span>
            <span className="text-sm font-medium tracking-tight text-muted-foreground">unClaw</span>
          </div>

          <div className="animate-blur-rise mt-7 space-y-6">
            <div className="space-y-1.5">
              <h1 className="font-display text-[1.75rem] leading-tight tracking-tight text-balance">{title}</h1>
              {description && (
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{description}</p>
              )}
            </div>
            {children}
          </div>

          {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
        </div>
      </div>
    </div>
  );
}
