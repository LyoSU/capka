"use client";

/**
 * App-Store-style square avatar for a plugin or skill: a monogram on a calm tint
 * derived from the name, so every item reads as a distinct "app".
 *
 * Deliberately NOT a remote favicon: the old version fetched
 * google.com/s2/favicons, which leaked every configured plugin/connector hostname
 * to Google on render and broke icons in offline/air-gapped deployments — both at
 * odds with a self-hosted, privacy-positioned product. `homepage` is accepted for
 * call-site compatibility but no longer triggers any network request.
 */
export function PluginIcon({
  name,
  size = 40,
}: {
  name: string;
  homepage?: string | null;
  size?: number;
}) {
  const px = `${size}px`;
  const radius = Math.round(size * 0.28);

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
