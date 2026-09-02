"use client";

import { cn } from "@/lib/utils";

/**
 * The one segmented control in the app: a sunken track with a single raised knob
 * riding in it.
 *
 * There were five hand-rolled copies of this markup — settings tabs, the plugins
 * hub, the agent-mode preset, and the connector form's kind + auth pickers — all
 * identical to the pixel and all but one with no accessible role at all, so a
 * screen reader met a row of unrelated buttons instead of one control with a
 * chosen value. The skin lives here; the MEANING is the caller's, which is what
 * `as` is for: a tablist switches which view you're looking at, a radiogroup
 * picks a value. Those are different promises and the control has to make the
 * right one, even though they look alike.
 *
 * Depth carries the state (`bg-muted` recesses the track, `shadow-btn` lifts the
 * selection) rather than colour alone — the same material logic as the thinking
 * slider's knob. `bg-muted`, not `bg-field`: the field token is the page's
 * WHITEST value now, so a track painted with it was a white pill with a white
 * knob in it, and the knob had nothing to rise from.
 */
export function Segmented<K extends string>({
  value,
  onChange,
  options,
  as = "tablist",
  label,
  size = "default",
  readout,
}: {
  /** `null` = none of the options is the current value, which only a radiogroup
   *  with a `readout` can honestly be in. */
  value: K | null;
  onChange: (key: K) => void;
  /** `tone` colours the option ONLY while it is the selection — a governance
   *  effect encodes risk in colour, and a knob painted allow-green or deny-red
   *  says which way the switch is thrown from across the room. Unselected
   *  options stay grey so the track never reads as three lit buttons. */
  options: { key: K; label: string; icon?: React.ComponentType<{ className?: string }>; tone?: string }[];
  /** `tablist` switches views (the default); `radiogroup` picks a value. */
  as?: "tablist" | "radiogroup";
  /** Accessible name. A radiogroup needs one — its options are values, and
   *  "assistant / raw" says nothing without the question they answer. Tabs are
   *  named by the view they reveal, so they don't. */
  label?: string;
  size?: "default" | "sm";
  /** A state the user can't choose, shown after the options — e.g. "Custom",
   *  meaning the current value matches none of them. Declared as a checked,
   *  disabled option so the group is still made of options only. */
  readout?: string;
}) {
  if (options.length < 2) return null;
  const tabs = as === "tablist";
  const pad = size === "sm" ? "p-0.5" : "p-1";
  const cell = size === "sm" ? "rounded px-2.5 py-1 text-sm" : "rounded-md px-3 py-1.5 text-sm";

  return (
    <div role={as} aria-label={label} className={cn("inline-flex rounded-lg bg-muted", pad)}>
      {options.map((option) => {
        const on = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role={tabs ? "tab" : "radio"}
            {...(tabs ? { "aria-selected": on } : { "aria-checked": on })}
            onClick={() => onChange(option.key)}
            className={cn(
              "flex items-center gap-1.5 transition-micro",
              cell,
              on ? cn("bg-card font-medium shadow-btn", option.tone) : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon && <option.icon className="h-4 w-4" />}
            {option.label}
          </button>
        );
      })}
      {readout && (
        <span
          role={tabs ? "tab" : "radio"}
          {...(tabs ? { "aria-selected": true } : { "aria-checked": true })}
          aria-disabled="true"
          className={cn("font-medium bg-card shadow-btn", cell)}
        >
          {readout}
        </span>
      )}
    </div>
  );
}
