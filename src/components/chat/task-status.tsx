"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { describeStep } from "./steps";

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return "";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}:${String(remSec).padStart(2, "0")}`;
}

export function TaskStatus({
  startedAt,
  currentTool,
  retrying,
}: {
  startedAt: number;
  currentTool: string | null;
  // Set while the runner is re-streaming after a provider stall — takes over the
  // label so the user sees the model is slow rather than a frozen spinner.
  retrying?: { attempt: number; max: number } | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const tSteps = useTranslations("steps");
  const t = useTranslations("chat.taskStatus");

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const label = retrying
    ? t("retrying")
    : currentTool
      ? describeStep(tSteps, currentTool).activeLabel
      : t("thinking");
  const time = formatElapsed(elapsed);

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
      {/* Withheld for the first 5s by `formatElapsed`, on purpose: putting a number
          on a fast operation measures it for the user and thereby makes it feel
          slow. It appears only once the wait is long enough that not knowing is
          worse than knowing. `tabular-nums` stops the row twitching as digits
          change width. */}
      {time ? <span className="text-muted-foreground tabular-nums">· {time}</span> : null}
    </div>
  );
}
