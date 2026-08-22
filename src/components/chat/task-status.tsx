"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatLiveElapsed } from "@/lib/chat/duration";
import { describeStep } from "./steps";

export function TaskStatus({
  startedAt,
  currentTool,
  retrying,
  phase,
}: {
  startedAt: number;
  currentTool: string | null;
  // Set while the runner is re-streaming after a provider stall — takes over the
  // label so the user sees the model is slow rather than a frozen spinner.
  retrying?: { attempt: number; max: number } | null;
  // Which contentless stretch of the turn we're in, when we know (see
  // useBackgroundChat). Names the wait instead of calling all of it "Thinking…".
  phase?: "queued" | "preparing" | "sandbox" | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const tSteps = useTranslations("steps");
  const tDuration = useTranslations("chat.duration");
  const t = useTranslations("chat.taskStatus");

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // One row, one label, in order of what the user most needs to know. A stall
  // outranks everything (it explains a spinner that has stopped meaning
  // progress); a running tool outranks a phase (the concrete action beats the
  // machinery behind it); a known phase outranks the generic word. "Thinking…"
  // is the honest floor: the model is working and we have nothing more specific.
  const label = retrying
    ? t("retrying")
    : currentTool
      ? describeStep(tSteps, currentTool).activeLabel
      : phase
        ? t(phase)
        : t("thinking");
  const time = formatLiveElapsed(elapsed, tDuration);

  // Mirrors a running rail node (27px circle + spinner) so the live status reads
  // as the next step still being written, then a soft highlight sweeps the label.
  return (
    <div role="status" aria-live="polite" className="flex animate-in items-center gap-3 py-1 text-sm fade-in duration-300">
      <span
        className="grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full border border-border bg-card text-foreground"
        aria-hidden="true"
      >
        <span className="spinner-ring h-3.5 w-3.5 animate-spin rounded-full" />
      </span>
      {/* Plain text, not `text-shimmer`. The spinner to its left is already a
          motion signal meaning "working"; sweeping a highlight across the label
          says the identical thing a second time. Icon + words + elapsed time are
          three complementary channels (that it's running, what it's doing, how
          long) — a fourth animation adds no channel, only noise. */}
      <span className="font-medium">{label}</span>
      {/* Withheld for the first 5s by `formatLiveElapsed`, on purpose: putting a
          number on a fast operation measures it for the user and thereby makes it
          feel slow. It appears only once the wait is long enough that not knowing
          is worse than knowing. `tabular-nums` stops the row twitching as digits
          change width. */}
      {time ? <span className="text-muted-foreground tabular-nums">· {time}</span> : null}
    </div>
  );
}
