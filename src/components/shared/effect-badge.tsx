import { cn } from "@/lib/utils";

/** A governance decision, in the order risk decreases. */
export type PolicyEffect = "allow" | "ask" | "deny";

/**
 * The visual for a governance decision — shared so the same three states never
 * read as three different things on two admin screens.
 *
 * This existed twice before, and the copies had drifted into different visual
 * languages: the permissions screen used coloured text as a traffic light, while a
 * person's drawer used `<Badge>` variants where `allow` came out as `outline` — the
 * LEAST emphasized of the three, even though a standing permission is the state an
 * admin most needs to notice. Colour encodes risk here, one way, everywhere.
 *
 * It takes an already-translated `label` rather than a translator, on purpose. The
 * permissions screen labels a CONTROL you are setting ("Allow", imperative); a
 * drawer reports a CURRENT VALUE ("Allowed", a state). Two grammars for two roles
 * is correct localization and belongs at the call site — the colour is the only
 * part that must not vary.
 */
export function EffectBadge({
  effect,
  label,
  className,
}: {
  effect: string;
  label: string;
  className?: string;
}) {
  // `--destructive` is a button FILL (globals.css: white text needs that
  // lightness); `--destructive-text` is the token tuned for red TEXT and clears
  // contrast on the pale background, which the fill colour only just did.
  const tone: Record<PolicyEffect, string> = {
    allow: "text-success",
    ask: "text-warning-text",
    deny: "text-destructive-text",
  };
  const known = effect === "allow" || effect === "ask" || effect === "deny";
  return (
    <span
      className={cn(
        "shrink-0 text-xs font-medium",
        known ? tone[effect as PolicyEffect] : "text-muted-foreground",
        className,
      )}
    >
      {label}
    </span>
  );
}
