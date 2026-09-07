"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { MessageCircleQuestion, WandSparkles, Scissors, Sparkles, TextQuote, type LucideIcon } from "lucide-react";

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

const asQuote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** The instruction, then the passage as a markdown quote, then room to type. */
export function quotePrompt(instruction: string, quote: string): string {
  const quoted = asQuote(quote);
  return instruction ? `${instruction}\n\n${quoted}` : `${quoted}\n\n`;
}

/**
 * The same, for a passage of a FILE rather than of an answer.
 *
 * `source` is the line that names the file ("From report.md:"). Without it the
 * agent gets a quote with no idea which of a dozen workspace files it came from,
 * and the user gets an answer about the wrong document. Room to type is always
 * left at the end: quoting a file is a preamble, never the whole message.
 */
export function fileQuotePrompt(instruction: string, source: string, quote: string): string {
  const body = `${source}\n${asQuote(quote)}\n\n`;
  return instruction ? `${instruction}\n\n${body}` : body;
}

/** The current selection when both its ends sit inside ONE answer, else null. A
 *  selection that starts in an answer and runs out of it is not a passage. */
export function answerSelection(
  sel: Selection | null,
  root: ParentNode = document,
  selector: string = ANSWER_SELECTOR,
): { text: string; range: Range } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const owner = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest(selector) ?? null;
  const a = owner(sel.anchorNode);
  if (!a || a !== owner(sel.focusNode) || !root.contains(a)) return null;
  const text = sel.toString();
  if (text.trim().length < 3) return null;
  return { text, range: sel.getRangeAt(0) };
}

/** A passage of an OPEN FILE, as opposed to `[data-answer]` for a passage of a
 *  reply. Two separate marks so the transcript's bar and the viewer's can both be
 *  mounted and neither ever claims the other's selection. */
export const PREVIEW_TEXT_SELECTOR = "[data-preview-text]";

type Anchor = { x: number; y: number; text: string };

/** One button in the bar. `prompt` turns the highlighted passage into the text
 *  the composer is filled with — which is the only thing that differs between an
 *  answer's bar and a file's. */
export type SelectionItem = {
  id: string;
  Icon: LucideIcon;
  label: string;
  prompt: (quote: string) => string;
};

const ACTIONS = [
  { id: "explain", Icon: MessageCircleQuestion },
  { id: "simplify", Icon: WandSparkles },
  { id: "shorten", Icon: Scissors },
  { id: "ask", Icon: TextQuote },
] as const;

export function SelectionActions({
  onPrompt,
  selector = ANSWER_SELECTOR,
  items,
}: {
  onPrompt: (text: string) => void;
  /** What counts as selectable text. Both ends of the selection must sit inside
   *  ONE element matching this, which is also what keeps two mounted bars (an
   *  answer's and an open file's) from ever claiming the same selection. */
  selector?: string;
  /** Defaults to the four things people do with a paragraph of an answer. */
  items?: SelectionItem[];
}) {
  const t = useTranslations("chat.selection");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const actions: SelectionItem[] =
    items ??
    ACTIONS.map(({ id, Icon }) => ({
      id,
      Icon,
      label: t(id),
      prompt: (quote: string) => quotePrompt(id === "ask" ? "" : t(`prompt.${id}`), quote),
    }));

  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dragging = false;

    const place = () => {
      const hit = answerSelection(window.getSelection(), document, selector);
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
  }, [selector]);

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

  const run = (item: SelectionItem) => {
    onPrompt(item.prompt(anchor.text));
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
        {actions.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => run(item)}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-foreground transition-micro hover:bg-hover active:scale-[0.96]"
          >
            <item.Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The same bar over an open file, for the host that has a composer to fill.
 *
 * It lives here rather than in the viewer because the viewer also opens over the
 * project hub and the settings pages, where there is nothing to quote INTO — and
 * a component that names a namespace drags that namespace's strings into every
 * route that can reach it. So the chat's workspace column builds this and hands
 * it down; nobody else does.
 *
 * Same three verbs as the transcript's bar, re-aimed at a document: every one of
 * them names the file, because a quote arriving on its own is a paragraph the
 * agent has no way to place among a dozen workspace files.
 */
export function PreviewSelectionActions({
  fileName,
  onPrompt,
}: {
  fileName: string;
  onPrompt: (text: string) => void;
}) {
  const t = useTranslations("chat.selection");
  const items = useMemo<SelectionItem[]>(() => {
    const source = t("fromFile", { name: fileName });
    return [
      { id: "quote", Icon: TextQuote, label: t("quote"), prompt: (q) => fileQuotePrompt("", source, q) },
      { id: "explain", Icon: MessageCircleQuestion, label: t("explain"), prompt: (q) => fileQuotePrompt(t("prompt.explainFile"), source, q) },
      { id: "ask", Icon: Sparkles, label: t("ask"), prompt: (q) => fileQuotePrompt(t("prompt.askFile"), source, q) },
    ];
  }, [t, fileName]);

  return <SelectionActions onPrompt={onPrompt} selector={PREVIEW_TEXT_SELECTOR} items={items} />;
}
