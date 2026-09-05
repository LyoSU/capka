"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { MessageCircleQuestion, WandSparkles, Scissors, TextQuote } from "lucide-react";

/**
 * Highlight a passage of an answer and hand it to the agent.
 *
 * A small pill under the selection offers the things people actually do with a
 * paragraph they did not fully get: have it explained, said simpler, said
 * shorter, or quoted into a question of their own. Each action fills the
 * composer with the passage as a quote under a one-line instruction and hands
 * over focus — the user still sends, so a mis-selection costs nothing.
 *
 * Pointer devices only. On touch the OS already owns the selection handles and
 * puts its own menu over the text; a second bar there would fight it.
 */

/** The selector marking the text a reader may hand to the agent: assistant prose,
 *  not the user's own messages, tool output, or the composer. */
export const ANSWER_SELECTOR = "[data-answer]";

/** Wait after the last selection change before showing — the bar must not chase
 *  a selection that is still being dragged out. */
const SETTLE_MS = 120;

/** The instruction, then the passage as a markdown quote, then room to type. */
export function quotePrompt(instruction: string, quote: string): string {
  const quoted = quote
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return instruction ? `${instruction}\n\n${quoted}` : `${quoted}\n\n`;
}

/** The current selection when both its ends sit inside ONE answer, else null. A
 *  selection that starts in an answer and runs out of it is not a passage. */
export function answerSelection(sel: Selection | null, root: ParentNode = document): { text: string; range: Range } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const owner = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest(ANSWER_SELECTOR) ?? null;
  const a = owner(sel.anchorNode);
  if (!a || a !== owner(sel.focusNode) || !root.contains(a)) return null;
  const text = sel.toString();
  if (text.trim().length < 3) return null;
  return { text, range: sel.getRangeAt(0) };
}

type Anchor = { x: number; y: number; text: string };

const ACTIONS = [
  { id: "explain", Icon: MessageCircleQuestion },
  { id: "simplify", Icon: WandSparkles },
  { id: "shorten", Icon: Scissors },
  { id: "ask", Icon: TextQuote },
] as const;

export function SelectionActions({ onPrompt }: { onPrompt: (text: string) => void }) {
  const t = useTranslations("chat.selection");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dragging = false;

    const place = () => {
      const hit = answerSelection(window.getSelection());
      if (!hit) {
        setAnchor(null);
        return;
      }
      const lines = hit.range.getClientRects();
      const last = lines[lines.length - 1];
      const bounds = hit.range.getBoundingClientRect();
      if (!last || bounds.width === 0) {
        setAnchor(null);
        return;
      }
      // Under the last selected line, centred on the whole selection — the bar
      // sits where the reading stopped, not in the middle of a tall passage.
      setAnchor({ x: bounds.left + bounds.width / 2, y: last.bottom + 8, text: hit.text });
    };
    const settle = () => {
      clearTimeout(timer);
      if (dragging) return;
      timer = setTimeout(place, SETTLE_MS);
    };
    const down = () => {
      dragging = true;
      setAnchor(null);
    };
    const up = () => {
      dragging = false;
      settle();
    };
    document.addEventListener("selectionchange", settle);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    // The bar is fixed to the viewport, so anything that moves the text moves it.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", settle);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, []);

  // Keep the whole bar on screen: it is centred on the selection, which can sit
  // against either edge of a narrow column.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || !anchor) return;
    const half = el.offsetWidth / 2;
    const x = Math.max(12 + half, Math.min(anchor.x, window.innerWidth - 12 - half));
    el.style.left = `${x}px`;
  }, [anchor]);

  if (!anchor) return null;

  const run = (id: (typeof ACTIONS)[number]["id"]) => {
    onPrompt(quotePrompt(id === "ask" ? "" : t(`prompt.${id}`), anchor.text));
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };

  return createPortal(
    // The outer element carries the position, the inner one the entrance: a
    // transform-based centring on the same element as `pop-in` would be
    // overwritten by the animation's own transform.
    <div
      ref={barRef}
      className="fixed z-50 -translate-x-1/2"
      style={{ left: anchor.x, top: anchor.y }}
      // Selecting inside the bar itself must not tear the selection down.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div role="toolbar" aria-label={t("label")} className="animate-pop-in flex h-9 items-center gap-0.5 rounded-full bg-popover p-1 text-popover-foreground shadow-overlay">
        {ACTIONS.map(({ id, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => run(id)}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-foreground transition-micro hover:bg-hover active:scale-[0.96]"
          >
            <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {t(id)}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
