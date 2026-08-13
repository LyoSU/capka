"use client";

import { useCallback, useState } from "react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { useChatScroll, ChatScrollProvider, useDisclosureAnchor } from "@/components/chat/use-chat-scroll";

/**
 * A driveable rig for the chat transcript's scroll engine.
 *
 * WHY THIS EXISTS. Everything the engine DECIDES is unit-tested as arithmetic
 * (`lib/chat/scroll-plan`), and a handful of architectural properties are pinned by
 * structural guards. Neither can test the part that actually broke twice: the ORDER
 * of real DOM events. A touch becoming momentum becoming a keyboard animation, a
 * ResizeObserver firing between layout and paint, a disclosure animating while a
 * reply streams — those are browser sequencing, and only a browser can run them.
 *
 * It renders the same contract the real panel does — the same refs, the same
 * `data-scroll-anchor` blocks, a footer whose measured height is the reserve — with
 * fake content and a button for every scenario. What it deliberately does NOT do is
 * touch the database, the session, or any API: it is the engine under glass, so a
 * failure here is a failure of the engine and nothing else.
 *
 * Reachable only when NODE_ENV is not production AND `CAPKA_SCROLL_HARNESS=1`; the
 * route's server component 404s otherwise. It needs no authentication exemption —
 * a test supplies any session cookie value, since the proxy only checks for one.
 */

interface Block {
  id: string;
  role: "user" | "assistant";
  lines: number;
  /** Renders a real disclosure, so a press goes through the real ownership path. */
  disclosure?: boolean;
  /** Renders an image that only resolves after a delay, changing height with
   *  nothing to announce it — the class of change React never re-renders for. */
  delayedMedia?: boolean;
}

let seq = 0;
const mk = (role: Block["role"], lines: number, extra: Partial<Block> = {}): Block =>
  ({ id: `b${++seq}`, role, lines, ...extra });

function DelayedMedia() {
  const [ready, setReady] = useState(false);
  return (
    <div data-testid="delayed-media" style={{ height: ready ? 240 : 0, background: "#ddd" }}>
      <button type="button" data-testid="resolve-media" onClick={() => setReady(true)}>
        resolve media
      </button>
    </div>
  );
}

function Spoiler({ id, lines }: { id: string; lines: number }) {
  const anchorDisclosure = useDisclosureAnchor();
  return (
    <Collapsible defaultOpen={false} onOpenChange={(_, d) => anchorDisclosure(d)}>
      <CollapsibleTrigger data-testid={`spoiler-${id}`}>spoiler {id}</CollapsibleTrigger>
      <CollapsibleContent>
        <div data-testid={`spoiler-body-${id}`}>
          {Array.from({ length: lines }, (_, i) => <p key={i}>hidden line {i}</p>)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ScrollHarness() {
  const [blocks, setBlocks] = useState<Block[]>(() => [mk("user", 2), mk("assistant", 6)]);
  const [streaming, setStreaming] = useState(false);
  const [footerExtra, setFooterExtra] = useState(0);
  const turnKey = blocks.findLast((b) => b.role === "user")?.id;

  const scroll = useChatScroll({
    turnKey,
    isStreaming: streaming,
    messageCount: blocks.length,
    enabled: true,
  });
  const actions = scroll.actions;

  const add = useCallback((n: number, extra: Partial<Block> = {}) => {
    setBlocks((b) => [...b, ...Array.from({ length: n }, () => mk("assistant", 8, extra))]);
  }, []);

  /** Grow the last assistant block, the way a streamed delta does. */
  const growTail = useCallback((lines: number) => {
    setBlocks((b) => b.map((x, i) => (i === b.length - 1 ? { ...x, lines: x.lines + lines } : x)));
  }, []);

  /** A turn this client sent: the pin is claimed before the bubble appears. */
  const send = useCallback(() => {
    actions.armForSend();
    setBlocks((b) => [...b, mk("user", 2), mk("assistant", 3)]);
    setStreaming(true);
  }, [actions]);

  /** A turn that merely appeared — Telegram, an automation, another tab. */
  const externalTurn = useCallback(() => {
    setBlocks((b) => [...b, mk("user", 2), mk("assistant", 4)]);
  }, []);

  /**
   * Stand in for iOS: the publisher writes `--kb`, the engine reads it back.
   *
   * Re-asserted AFTER the dispatch on purpose. The real publisher listens to the
   * same visual-viewport event and recomputes the inset from actual geometry, which
   * has not changed here — so it would reset this to zero synchronously inside the
   * dispatch, before the engine reads it on the next frame.
   */
  const setKeyboard = useCallback((px: number) => {
    const root = document.documentElement;
    root.style.setProperty("--kb", `${px}px`);
    window.visualViewport?.dispatchEvent(new Event("resize"));
    root.style.setProperty("--kb", `${px}px`);
  }, []);

  const controls: [string, () => void][] = [
    ["send", send],
    ["external-turn", externalTurn],
    ["stream-on", () => setStreaming(true)],
    ["stream-off", () => setStreaming(false)],
    ["grow-tail", () => growTail(3)],
    ["grow-tail-big", () => growTail(40)],
    ["add-1", () => add(1)],
    ["add-20", () => add(20)],
    ["add-500", () => add(500)],
    ["add-spoiler", () => add(1, { disclosure: true })],
    ["add-media", () => add(1, { delayedMedia: true })],
    ["footer-grow", () => setFooterExtra(120)],
    ["footer-shrink", () => setFooterExtra(0)],
    ["keyboard-open", () => setKeyboard(320)],
    ["keyboard-close", () => setKeyboard(0)],
    ["jump-bottom", () => actions.jumpToBottom()],
  ];

  return (
    <ChatScrollProvider value={actions}>
      <div className="flex h-dvh flex-col">
        {/* Kept outside the scroll container, like the real panel's controls. */}
        <div className="flex flex-wrap gap-1 border-b p-2 text-xs">
          {controls.map(([name, fn]) => (
            <button key={name} type="button" data-testid={name} onClick={fn} className="rounded border px-2 py-1">
              {name}
            </button>
          ))}
          <span data-testid="state">{`${scroll.showJump ? "jump" : "-"}/${scroll.jumpTone}/${scroll.activeUserId ?? "-"}`}</span>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            ref={scroll.scrollRef}
            data-testid="scroller"
            className="flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
            style={{
              paddingTop: "var(--reading-line)",
              paddingBottom: `calc(${scroll.bottomReserve}px + var(--kb, 0px))`,
              scrollPaddingBlockStart: "var(--reading-line)",
              scrollPaddingBlockEnd: `calc(${scroll.bottomReserve}px + var(--kb, 0px))`,
            }}
          >
            <div className="mx-auto max-w-3xl px-4">
              {blocks.map((b) => (
                <div
                  key={b.id}
                  data-msg-id={b.id}
                  data-role={b.role}
                  data-scroll-anchor="msg"
                  data-testid={`block-${b.id}`}
                  ref={b.id === turnKey ? scroll.pinRef : undefined}
                  className="py-4"
                >
                  <div data-scroll-anchor="text">
                    {Array.from({ length: b.lines }, (_, i) => (
                      <p key={i}>{b.role} {b.id} line {i}</p>
                    ))}
                  </div>
                  {b.disclosure && <div data-scroll-anchor="activity"><Spoiler id={b.id} lines={30} /></div>}
                  {b.delayedMedia && <DelayedMedia />}
                </div>
              ))}
              <div ref={scroll.contentEndRef} data-testid="content-end" />
              <div ref={scroll.spacerRef} aria-hidden className="shrink-0" />
            </div>
          </div>

          {/* Same shape as the real footer: a gradient band whose padding is the air
              above the last line, with the interactive block inside it. */}
          <div
            ref={scroll.footerRef}
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-background pt-6"
            style={{ transform: "translateY(calc(-1 * var(--kb, 0px)))" }}
          >
            <div className="pointer-events-auto border-t p-3" style={{ paddingBottom: 12 + footerExtra }}>
              composer
            </div>
          </div>
        </div>
      </div>
    </ChatScrollProvider>
  );
}
