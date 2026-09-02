"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ImageOff } from "lucide-react";

/**
 * A markdown image in an answer, with a place before it has pixels.
 *
 * An unsized <img> is zero height until it decodes, then shoves everything below
 * it by its full height — the one layout shift the scroll engine had to absorb on
 * every image in every reply. So the picture renders into a reserved 3:2 box that
 * pulses while it loads, and fades in once decoded; the box then takes the real
 * size, which is one shift instead of one per frame of decoding. A picture that
 * fails becomes a quiet labelled chip rather than vanishing — Streamdown's default
 * hides a broken image, which leaves a sentence pointing at nothing. Height is
 * capped so a tall screenshot never takes over the transcript.
 */
export function ChatImage({ src, alt }: { src?: string; alt?: string }) {
  const t = useTranslations("chat.message");
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const ref = useRef<HTMLImageElement>(null);
  // A cached image can be complete before React attaches the load handler, and
  // then `onLoad` never fires; read the element once after mount.
  useEffect(() => {
    const el = ref.current;
    if (el?.complete && el.naturalWidth > 0) setState("loaded");
  }, []);

  if (!src) return null;
  if (state === "error") {
    return (
      <span className="my-3 inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{alt || t("imageUnavailable")}</span>
      </span>
    );
  }
  const loading = state === "loading";
  return (
    <span className={`my-3 block overflow-hidden rounded-lg ${loading ? "aspect-[3/2] w-full max-w-sm animate-pulse-fast bg-muted/40" : "w-fit max-w-full"}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote or workspace image named in markdown, not a static asset */}
      <img
        ref={ref}
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={`block h-auto max-h-[28rem] w-auto max-w-full transition-opacity duration-300 ${loading ? "opacity-0" : "opacity-100"}`}
      />
    </span>
  );
}
