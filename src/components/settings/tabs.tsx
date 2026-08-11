"use client";

import { cn } from "@/lib/utils";

/**
 * The segmented tab control the settings pages share.
 *
 * Lifted out of the Extensions page, which had the only copy, when People and
 * Permissions needed the same thing. Generic over the key type so each page keeps
 * its own union of tab names instead of passing strings around.
 */
export function SettingsTabs<K extends string>({
  value,
  onChange,
  tabs,
}: {
  value: K;
  onChange: (key: K) => void;
  tabs: { key: K; label: string; icon?: React.ComponentType<{ className?: string }> }[];
}) {
  if (tabs.length < 2) return null;

  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
            value === tab.key ? "bg-card font-medium shadow-btn" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.icon && <tab.icon className="h-4 w-4" />}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
