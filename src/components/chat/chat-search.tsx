"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useSidebar } from "@/components/ui/sidebar";

export function ChatSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("chat");
  const inputRef = useRef<HTMLInputElement>(null);

  const { setOpen, setOpenMobile, isMobile } = useSidebar();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // `e.code`, not `e.key`: with Shift held the key IS "F", so the old
      // lowercase comparison meant the shortcut the command palette advertises
      // could never fire. `code` is also layout-independent.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        // The field lives inside the sidebar, and a collapsed rail (or a closed
        // mobile sheet) hides it — focus() on a hidden input is a silent no-op,
        // so the advertised shortcut looked broken. Open the sidebar first and
        // focus once it has painted.
        if (isMobile) setOpenMobile(true);
        else setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setOpen, setOpenMobile]);

  return (
    <div className="px-3 pb-1">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // Escape clears the filter (keeping focus) when there's a query, the
          // same one-key escape hatch a search box is expected to offer.
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
            }
          }}
          placeholder={t("searchChats")}
          className="h-8 border-0 bg-transparent pl-7 pr-7 text-[15px] shadow-none transition-micro hover:bg-hover focus-visible:bg-field focus-visible:shadow-hairline"
        />
        {value && (
          <button
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label={t("clearSearch")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground before:absolute before:-inset-3.5 before:content-[''] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
