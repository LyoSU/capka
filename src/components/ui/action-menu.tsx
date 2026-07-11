"use client";

import * as React from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

export type ActionItem = {
  key: string;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
  hidden?: boolean;
};

/**
 * One long-press/⋮ menu, two presentations. On a fine pointer (desktop) it is
 * the familiar `DropdownMenu` popover anchored to `children`. On touch it is a
 * full-width action sheet pinned to the bottom of the screen — a far bigger tap
 * target than a floating popover clinging to a row.
 *
 * The items are passed as *data* rather than JSX children because a
 * `DropdownMenuItem` (Base UI `Menu.Item`) only works inside a `Menu.Root`; it
 * cannot be re-rendered inside the sheet (a `Dialog`). Describing each row once
 * lets both containers render it their own way.
 *
 * `children` (the invisible anchor and the desktop ⋮ trigger) always render
 * inside a `Menu.Root` so their context is valid — on touch that root is simply
 * kept closed and the sheet, driven by the real `open`, takes over.
 */
export function ActionMenu({
  open,
  onOpenChange,
  title,
  ariaLabel,
  items,
  children,
  contentProps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible sheet heading on touch (chat title / message preview). */
  title?: string;
  /** Accessible name for the sheet dialog; required for a11y. */
  ariaLabel: string;
  items: ActionItem[];
  children: React.ReactNode;
  contentProps?: React.ComponentProps<typeof DropdownMenuContent>;
}) {
  const isMobile = useIsMobile();
  const visible = items.filter((it) => !it.hidden);

  return (
    <DropdownMenu open={isMobile ? false : open} onOpenChange={onOpenChange}>
      {children}
      {!isMobile && (
        <DropdownMenuContent {...contentProps}>
          {visible.map((it, i) => {
            const prev = visible[i - 1];
            const needsSeparator =
              it.variant === "destructive" && prev && prev.variant !== "destructive";
            return (
              <React.Fragment key={it.key}>
                {needsSeparator && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant={it.variant}
                  disabled={it.disabled}
                  onClick={it.onSelect}
                >
                  {it.icon}
                  {it.label}
                </DropdownMenuItem>
              </React.Fragment>
            );
          })}
        </DropdownMenuContent>
      )}
      {isMobile && (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <ActionSheet
            title={title}
            ariaLabel={ariaLabel}
            items={visible}
            onOpenChange={onOpenChange}
          />
        </Sheet>
      )}
    </DropdownMenu>
  );
}

const SWIPE_CLOSE_PX = 60;

function ActionSheet({
  title,
  ariaLabel,
  items,
  onOpenChange,
}: {
  title?: string;
  ariaLabel: string;
  items: ActionItem[];
  onOpenChange: (open: boolean) => void;
}) {
  const dragRef = React.useRef<HTMLDivElement>(null);
  const start = React.useRef<number | null>(null);
  const [dragY, setDragY] = React.useState(0);

  // Swipe-down-to-dismiss, tracked only on the handle/header strip so taps on
  // the action rows are never swallowed. The whole sheet body follows the finger
  // (clamped to downward), then either snaps back or closes past the threshold.
  const onTouchStart = (e: React.TouchEvent) => {
    start.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (start.current == null) return;
    const dy = (e.touches[0]?.clientY ?? 0) - start.current;
    setDragY(Math.max(0, dy));
  };
  const onTouchEnd = () => {
    if (dragY > SWIPE_CLOSE_PX) {
      onOpenChange(false);
    }
    start.current = null;
    setDragY(0);
  };

  return (
    <SheetContent
      side="bottom"
      showCloseButton={false}
      aria-label={ariaLabel}
      className="gap-0 rounded-t-2xl p-0 pb-[max(env(safe-area-inset-bottom),0.5rem)]"
    >
      <SheetTitle className="sr-only">{ariaLabel}</SheetTitle>
      <div
        ref={dragRef}
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragY ? "none" : "transform 0.2s cubic-bezier(0.32,0.72,0,1)",
        }}
      >
        {/* Grab strip — the drag gesture lives only here so taps on the action
            rows are never turned into a drag. */}
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="touch-none"
        >
          <div className="flex justify-center pt-2.5 pb-1">
            <div className="h-1 w-9 rounded-full bg-muted-foreground/30" />
          </div>
          {title && (
            <div className="truncate px-5 pb-2 pt-1 text-center text-sm font-medium text-muted-foreground">
              {title}
            </div>
          )}
        </div>
        <div className={cn("flex flex-col px-2 pt-1", !title && "pt-2")}>
          {items.map((it, i) => {
            const prev = items[i - 1];
            const needsSeparator =
              it.variant === "destructive" && prev && prev.variant !== "destructive";
            return (
              <React.Fragment key={it.key}>
                {needsSeparator && <div className="my-1 h-px bg-border" />}
                <button
                  type="button"
                  disabled={it.disabled}
                  onClick={() => {
                    haptic("tap");
                    onOpenChange(false);
                    it.onSelect();
                  }}
                  className={cn(
                    "flex min-h-[3rem] items-center gap-3 rounded-xl px-4 text-[15px] outline-none transition-colors active:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-5 [&_svg]:shrink-0",
                    it.variant === "destructive"
                      ? "text-destructive [&_svg]:text-destructive"
                      : "text-foreground [&_svg]:text-muted-foreground",
                  )}
                >
                  {it.icon}
                  {it.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </SheetContent>
  );
}
