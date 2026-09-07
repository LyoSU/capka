"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Mic } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Hint } from "@/components/ui/tooltip";

/**
 * The small chevron beside the microphone: which microphone the browser is using,
 * and whether it hears anything right now.
 *
 * This exists because "I pressed the button and nothing happened" has one honest
 * diagnosis in a browser — the microphone the speech engine listens to is silent,
 * blocked, or not the one the person expects — and the composer cannot tell that
 * from a working session until words arrive. A live level bar answers the question
 * in a second, before anyone speaks a sentence into the void.
 *
 * Deliberately NOT a device picker. The browser's speech engine (`SpeechRecognition`)
 * always captures from the system default input and offers no way to choose another;
 * a list that let the person pick would change the meter and not the dictation, which
 * is worse than no list. The device the meter shows IS the one dictation hears.
 */
export function MicSettings() {
  const t = useTranslations("chat.input.dictation");
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [device, setDevice] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "listening" | "denied" | "none">("idle");
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!open) {
      stopRef.current();
      return;
    }
    let cancelled = false;
    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof Error ? e.name : "";
        setState(name === "NotFoundError" || name === "OverconstrainedError" ? "none" : "denied");
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      setState("listening");
      // The track's own label is the default input's human name ("MacBook Air
      // Microphone"), available only once capture is permitted — which it now is.
      setDevice(stream.getAudioTracks()[0]?.label || null);

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        // RMS of the waveform around its 128 midpoint, scaled so ordinary speech
        // fills roughly half the bar and a shout fills it.
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stopRef.current = () => {
        cancelAnimationFrame(raf);
        for (const track of stream.getTracks()) track.stop();
        void ctx.close();
        stopRef.current = () => {};
        setLevel(0);
        setState("idle");
      };
    })();
    return () => {
      cancelled = true;
      stopRef.current();
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label={t("microphone")}>
        <PopoverTrigger
          aria-label={t("microphone")}
          className="inline-flex h-10 w-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:text-foreground data-popup-open:text-foreground sm:h-9 sm:w-5"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div
            role="meter"
            aria-label={t("level")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-75 motion-reduce:transition-none" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </div>
        <p className="mt-2 truncate text-sm text-foreground">
          {state === "denied" ? t("permissionDenied") : state === "none" ? t("noMicrophone") : device ?? t("microphoneDefault")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t("microphoneHint")}</p>
      </PopoverContent>
    </Popover>
  );
}
