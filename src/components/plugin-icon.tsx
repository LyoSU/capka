"use client";

import { useState } from "react";

/**
 * App-Store-style square avatar for a plugin or skill. Prefers the homepage's
 * favicon; falls back to a monogram on a calm tint derived from the name, so
 * every item still reads as a distinct "app" even without an icon.
 */
export function PluginIcon({
  name,
  homepage,
  size = 40,
}: {
  name: string;
  homepage?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  let host = "";
  try {
    if (homepage) host = new URL(homepage).hostname;
  } catch {
    /* no host */
  }

  const px = `${size}px`;
  const radius = Math.round(size * 0.28);

  if (host && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className="shrink-0 border border-border/60 bg-card object-cover"
        style={{ width: px, height: px, borderRadius: radius }}
      />
    );
  }

  // Deterministic hue from the name → stable, calm pastel monogram.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const letter = (name.trim()[0] || "?").toUpperCase();

  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center border font-medium"
      style={{
        width: px,
        height: px,
        borderRadius: radius,
        fontSize: size * 0.42,
        background: `oklch(0.93 0.04 ${hue})`,
        color: `oklch(0.42 0.09 ${hue})`,
        borderColor: `oklch(0.86 0.05 ${hue})`,
      }}
    >
      {letter}
    </div>
  );
}
