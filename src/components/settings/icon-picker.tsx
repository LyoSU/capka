"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ProviderGlyph, BRAND_ICON_SLUGS } from "@/components/chat/provider-icons";

/** A compact icon button that opens a grid of brand glyphs in a popover, so a
 *  connection can carry a recognizable mark. The first cell ("default") clears
 *  the override back to the provider's own glyph. */
export function IconPicker({
  value,
  fallback,
  onChange,
}: {
  value: string | null;
  onChange: (slug: string | null) => void;
  fallback: string;
}) {
  const t = useTranslations("settings.connections");
  const [open, setOpen] = useState(false);
  const options: (string | null)[] = [null, ...BRAND_ICON_SLUGS];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t("changeIcon")}
        // Square on the field scale (h-8/rounded-lg): it always sits beside an
        // Input, and at h-9/rounded-md it read as a taller, boxier neighbour.
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ProviderGlyph slug={value ?? fallback} size={16} />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-auto max-w-[calc(100vw-2rem)]">
        <div className="flex flex-wrap gap-1" style={{ width: "18rem" }}>
          {options.map((slug) => {
            const active = (value ?? null) === slug;
            return (
              <button
                key={slug ?? "_default"}
                type="button"
                onClick={() => {
                  onChange(slug);
                  setOpen(false);
                }}
                aria-pressed={active}
                className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-hover"
                }`}
              >
                <ProviderGlyph slug={slug ?? fallback} size={16} />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
