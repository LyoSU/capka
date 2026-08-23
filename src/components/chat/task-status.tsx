"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatLiveElapsed } from "@/lib/chat/duration";
import { gatePhase } from "@/lib/chat/phase-gate";
import { describeStep } from "./steps";

type Phase = "queued" | "preparing" | "sandbox";

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
  phase?: Phase | null;
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

  // A phase is only worth naming when the wait is long enough to need explaining,
  // and `gatePhase` decides that on two clocks (see its file). Most phases here
  // are over in a few hundred milliseconds, and the label announcing them used to
  // register as a twitch rather than a word — which is worse than silence, because
  // it pulls the eye to text that is gone before it can be read.
  //
  // Declared BEFORE the gate effect on purpose: both fire on a `phase` change, and
  // effects run in declaration order, so the timestamp is current by the time the
  // gate reads it.
  const phaseSince = useRef(0);
  useEffect(() => {
    phaseSince.current = Date.now();
  }, [phase]);

  const [gated, setGated] = useState<{ shown: Phase | null; shownAt: number }>({ shown: null, shownAt: 0 });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const next = gatePhase<Phase>({
        phase: phase ?? null,
        phaseSince: phaseSince.current,
        shown: gated.shown,
        shownAt: gated.shownAt,
        now: Date.now(),
      });
      if (next.shown !== gated.shown || next.shownAt !== gated.shownAt) {
        setGated({ shown: next.shown, shownAt: next.shownAt });
      }
      // Re-entered through this effect's own deps after a state change, so the
      // chain always terminates: the gate returns a null `recheckIn` exactly when
      // the displayed state is the settled one.
      if (next.recheckIn != null) timer = setTimeout(settle, next.recheckIn);
    };
    settle();
    return () => clearTimeout(timer);
  }, [phase, gated.shown, gated.shownAt]);

  // One row, one label, in order of what the user most needs to know. A stall
  // outranks everything (it explains a spinner that has stopped meaning
  // progress); a running tool outranks a phase (the concrete action beats the
  // machinery behind it); a known phase outranks the generic word. "Thinking…"
  // is the honest floor: the model is working and we have nothing more specific.
  // Note the asymmetry: only the PHASE goes through the gate. A running tool or a
  // stall is a stronger, rarer signal that has earned the slot immediately —
  // delaying those would withhold the most useful thing we know in order to
  // suppress a jitter they do not cause.
  const label = retrying
    ? t("retrying")
    : currentTool
      ? describeStep(tSteps, currentTool).activeLabel
      : gated.shown
        ? t(gated.shown)
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
      {/* Keyed on the text so a CHANGE of label cross-fades rather than snapping:
          the gate guarantees each word is up for at least its dwell, and a hard
          swap at that pace still reads as a twitch. The global reduced-motion
          reset in globals.css neutralises this automatically. */}
      <span key={label} className="animate-in font-medium fade-in duration-200">{label}</span>
      {/* Withheld for the first 5s by `formatLiveElapsed`, on purpose: putting a
          number on a fast operation measures it for the user and thereby makes it
          feel slow. It appears only once the wait is long enough that not knowing
          is worse than knowing. `tabular-nums` stops the row twitching as digits
          change width. */}
      {time ? <span className="text-muted-foreground tabular-nums">· {time}</span> : null}
    </div>
  );
}
