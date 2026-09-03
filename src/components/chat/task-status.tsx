"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatLiveElapsed } from "@/lib/chat/duration";
import { gatePhase } from "@/lib/chat/phase-gate";
import { describeStep } from "./steps";

type Phase = "queued" | "preparing" | "sandbox";

/** How long the stream must stay silent after streamed text before this row says
 *  "Thinking…" under it. Deltas land every ~250ms while the model writes, so a
 *  pause this long is not the gap between two batches — it is the model working
 *  on something the provider does not stream (Gemini returns a tool call's
 *  arguments in one piece, after generating all of them), and without the row
 *  the only sign the turn was alive was the Stop button. Longer than the caret's
 *  600ms on purpose: a caret blinking early is quiet, a row appearing early is a
 *  twitch. */
const QUIET_MS = 2000;

export function TaskStatus({
  startedAt,
  currentTool,
  retrying,
  phase,
  continuesRail,
  quietSince,
}: {
  startedAt: number;
  currentTool: string | null;
  // Set while the runner is re-streaming after a provider stall — takes over the
  // label so the user sees the model is slow rather than a frozen spinner.
  retrying?: { attempt: number; max: number } | null;
  // Which contentless stretch of the turn we're in, when we know (see
  // useBackgroundChat). Names the wait instead of calling all of it "Thinking…".
  phase?: Phase | null;
  // Whether the activity rail ends directly above this row (see the call site).
  // Purely presentational: it draws the short piece of connecting line that makes
  // the live row the rail's next node instead of a second, unrelated indicator.
  continuesRail?: boolean;
  // Set when the turn's last part is streamed text: the time the last realtime
  // event arrived. The row then stays hidden while words are still landing (the
  // growing text is the signal) and appears only once the stream has been quiet
  // for QUIET_MS. Undefined means "show at once", the row's other call sites.
  quietSince?: number;
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

  // Evaluated on every render, and the elapsed tick above re-renders this row once
  // a second, so the quiet period is noticed within a second of elapsing. A stall
  // or a running tool is stronger evidence than silence and is never withheld.
  if (quietSince != null && !retrying && !currentTool && Date.now() - quietSince < QUIET_MS) return null;

  // Same anatomy as a StepRow on the activity rail (message.tsx): the 20px glyph
  // box holding the same 14px spinner a running step wears, the 32px row, the
  // 15px muted label at the same inset — so the live status reads as the rail's
  // next step still being written, not as a second kind of indicator.
  return (
    <div role="status" aria-live="polite" className="relative flex min-h-8 animate-in items-center gap-2.5 py-1 text-[15px] leading-snug text-muted-foreground fade-in duration-300">
      {/* The last piece of the rail's connecting line, drawn from THIS side of the
          seam. The row is deliberately not a node inside the activity spoiler: it
          is mounted once, in one place, so it never remounts and flickers as the
          turn progresses — and putting it in the spoiler would let a reader
          collapse away the only sign the turn is still alive. So the two halves
          are laid out to meet: the glyphs are already one column (20px boxes at
          the same inset), the call site cancels the message's bottom padding, and
          this segment closes the seam between them. Geometry mirrors the rail's
          own hairline: centred under the glyph (left 10px), starting where the
          previous glyph box ends (6px above the seam) and stopping at this glyph
          box's top edge. */}
      {continuesRail && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-1.5 bottom-[calc(50%+10px)] left-2.5 w-px -translate-x-1/2 bg-border"
        />
      )}
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
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
      <span key={label} className="animate-in fade-in duration-200">{label}</span>
      {/* Withheld for the first 5s by `formatLiveElapsed`, on purpose: putting a
          number on a fast operation measures it for the user and thereby makes it
          feel slow. It appears only once the wait is long enough that not knowing
          is worse than knowing. `tabular-nums` stops the row twitching as digits
          change width. */}
      {time ? <span className="tabular-nums">· {time}</span> : null}
    </div>
  );
}
