"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { planScroll, easeStep, type ScrollOwner, type ScrollSnapshot } from "@/lib/chat/scroll-plan";
import { publishedKeyboardInset } from "@/hooks/use-keyboard-inset";

export type { ScrollOwner };

/** useLayoutEffect warns during SSR; this hook runs in a client component that is
 *  still rendered on the server, so fall back there. Stable per render. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * The chat transcript's whole scroll behaviour, in one place.
 *
 * WHY ONE MODULE. The transcript changes height from dozens of causes: every
 * streamed delta, every tool row, the reasoning spoiler collapsing at the end of a
 * turn, the composer growing when files are attached, the on-screen keyboard, an
 * <img> decoding, and — the ones nothing announces — the lazily imported
 * shiki/katex/mermaid chunk landing and re-laying-out every code block, formula and
 * diagram in the whole history. Handling those case by case is how you get several
 * places nudging `scrollTop` by their own delta and fighting each other.
 *
 * OWNERSHIP IS THE MODEL. Geometry cannot tell a reader expanding a spoiler from
 * the model appending a paragraph — in both cases content grew below what they are
 * looking at. Only the interaction knows, so ownership is declared, not inferred:
 * a send takes `pin`, streaming at rest takes `tail`, a disclosure press takes
 * `interaction`, and everything else is `reader`. See `scroll-plan.ts`, which holds
 * the whole state machine as pure arithmetic.
 *
 * WHY WE ANCHOR OURSELVES. Browsers do this natively via scroll anchoring, and
 * Chrome/Firefox/Android would have covered us — but WebKit only ships it in Safari
 * 27, which is beta; no shipping Safari has it. The same code therefore behaved
 * differently per platform: on Android the end of a turn was calm, on an iPhone it
 * jumped. We anchor in JS for everyone and set `overflow-anchor: none` so the
 * native one can't compensate on top of ours.
 */

/** Time constant for every eased scroll we drive: after ~3× this the distance is
 *  ~95% covered. See `easeStep` for why the curve is exponential, not a spring. */
const EASE_TAU_MS = 70;

/** Distance, in viewports, past which easing gives way to a jump. Easing across
 *  several screens doesn't read as motion, it reads as a broken scroller. */
const TELEPORT_VIEWPORTS = 2;

/** Backstop for `scrollend`, which WebKit only shipped in Safari 26.2 and so is
 *  still missing from plenty of phones a release behind. Armed only after the
 *  finger is up — see `touchActive`. */
const MOMENTUM_IDLE_MS = 140;

/** How long the layout must stay quiet before a freshly opened chat is considered
 *  assembled. Two frames is not enough — a decoding image or the syntax-highlight
 *  chunk lands whole frames later — and much more than this would keep overruling a
 *  reader who arrived and immediately scrolled. */
const RESTORE_QUIET_MS = 250;

/** Hard cap on that window, so a message containing a perpetual animation can't
 *  hold the end of the transcript indefinitely. */
const RESTORE_MAX_MS = 3000;

/** What the jump pill is saying. */
export type JumpTone = "idle" | "live" | "new";

/** Imperative handles, stable for the lifetime of the panel. Kept apart from the
 *  reactive values below so callbacks that must not change identity — anything
 *  passed to `memo(ChatMessage)` — can close over these directly instead of going
 *  through a ref the component has to maintain by hand. */
export interface ChatScrollActions {
  /** Call the moment a send is dispatched from THIS client: it is the only thing
   *  that may take the pin. A turn appearing on its own must never yank the screen
   *  away from what someone is reading. */
  armForSend: () => void;
  /** Re-run of the turn that already exists (regenerate). Produces no new turn key
   *  — the question is unchanged and already on screen — so the pin is taken now. */
  pinLatest: () => void;
  /**
   * The reader just pressed something that is about to change the transcript's
   * height — a disclosure, an inline editor. Holds `trigger` exactly still until
   * its animation finishes, outranking whatever was driving.
   *
   * This is what makes opening a spoiler at the end of the transcript behave: with
   * `tail` still in charge, the added height read as more reply to chase and the
   * pressed row shot upward. Ownership has to change BEFORE the geometry does,
   * which is why this is called from the toggle handler and not inferred later.
   */
  holdInteraction: (trigger: Element | null | undefined, holdMs?: number) => void;
  /** Pill: go to the tail and keep following it. */
  jumpToBottom: () => void;
  /** Nav minimap: bring a message to the reading line, then stop driving. */
  jumpToMessage: (id: string) => void;
}

export interface ChatScrollApi {
  /** The scroll container. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The newest user message — what `pin` holds on the reading line. */
  pinRef: React.RefObject<HTMLDivElement | null>;
  /** End of real content, before the spacer. The tail we follow. */
  contentEndRef: React.RefObject<HTMLDivElement | null>;
  /** Sized by us so a short reply can still lift its question to the top. */
  spacerRef: React.RefObject<HTMLDivElement | null>;
  /** The floating footer overlaying the foot of the transcript — its gradient band
   *  plus the composer, queue and error banner. Its measured height IS the room we
   *  reserve, so the last line of a reply rests exactly where the gradient begins.
   *  Anything that merely floats over the transcript (the jump pill) belongs
   *  outside its flow, so it costs no reserved space when hidden. */
  footerRef: React.RefObject<HTMLDivElement | null>;
  /** Room to reserve at the foot, in px, keyboard excluded — callers add
   *  `var(--kb)` in CSS so the keyboard stays one number in one place. */
  bottomReserve: number;
  /** True when the reader is away from the end and the jump pill should show. */
  showJump: boolean;
  jumpTone: JumpTone;
  /** The user turn on the reading line, for the nav minimap. */
  activeUserId: string | null;
  actions: ChatScrollActions;
}

interface Options {
  /** Identity of the newest user turn. A change means a new turn exists. */
  turnKey: string | undefined;
  /** Whether a turn is streaming right now. `tail` means nothing without one. */
  isStreaming: boolean;
  /** Bumped whenever the transcript's message list changes, so the anchor observer
   *  picks up new candidates. */
  messageCount: number;
  /** False while the greeting shows — the scroll container isn't mounted. */
  enabled: boolean;
}

/** Stable actions, published so disclosures deep in the transcript can declare
 *  ownership without prop-drilling through `memo(ChatMessage)`. */
const ChatScrollContext = createContext<ChatScrollActions | null>(null);

export const ChatScrollProvider = ChatScrollContext.Provider;

/**
 * Wire a disclosure so the row the reader pressed stays exactly where it is while
 * its panel grows or collapses.
 *
 * Base UI hands us the reason (`trigger-press` vs `none`) and the trigger element
 * itself, so a reader's press and a collapse the app performed on their behalf are
 * distinguished by the library rather than by us guessing from `pointerdown` — a
 * guess that would also have fired on a tap that scrolls nothing.
 */
export function useDisclosureAnchor() {
  const actions = useContext(ChatScrollContext);
  return useCallback(
    (details: { reason: string; trigger?: Element | undefined }) => {
      // `none` is a controlled change the app made (thinking auto-collapsing at the
      // end of a turn). That one is a system operation and must keep the reading
      // line, not jump to some trigger the reader never touched.
      if (details.reason !== "trigger-press") return;
      actions?.holdInteraction(details.trigger);
    },
    [actions],
  );
}

interface DebugState {
  owner: ScrollOwner;
  source: string;
  anchor: string | null;
  /** Which message the held element belongs to — the identity that makes a report
   *  like "the navigator highlighted the wrong turn" reproducible. */
  anchorId: string | null;
  /** How many candidates currently sit in the region below the reading line. */
  candidates: number;
  atRest: boolean;
  endVisible: boolean;
  keyboard: number;
  lastCorrection: number;
  /** Total `scrollTop` assignments since mount. */
  writes: number;
}

export function useChatScroll({ turnKey, isStreaming, messageCount, enabled }: Options): ChatScrollApi {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  // Only what the UI paints lives in React state: a streamed delta must not
  // re-render the transcript merely because the scroll position moved.
  const [bottomReserve, setBottomReserve] = useState(0);
  const [readingLine, setReadingLine] = useState(0);
  const [endVisible, setEndVisible] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  const s = useRef({
    owner: "reader" as ScrollOwner,
    /** Diagnostics only — the authority model has four owners, but knowing WHICH
     *  input took it is what makes a report like "it jumped when I scrolled"
     *  actionable. Never branched on. */
    source: "init",
    /** The last `scrollTop` WE wrote. Anything else means the reader moved, and
     *  that one comparison detects every input at once — wheel, touch,
     *  PageUp/Home/End, a scrollbar drag, find-in-page, a fragment navigation —
     *  without enumerating a single gesture. Enumerating them is why keyboard
     *  scrolling used to be invisible to this code. */
    written: -1,
    /** A finger is DOWN. Distinct from momentum on purpose: the idle timer below
     *  must never declare a gesture over while the reader is still touching, which
     *  is exactly what it used to do when they paused mid-pan. */
    touchActive: false,
    /** The reader is driving — finger down, or momentum still running. No writes
     *  in this window: `scrollTop` written during iOS momentum is felt as a jolt,
     *  and WebKit only addresses that class of bug in Safari 27. */
    readerActive: false,
    idleTimer: null as ReturnType<typeof setTimeout> | null,
    /** Deadline for `interaction` ownership: as long as the panel animates. */
    holdUntil: 0,
    animTo: null as number | null,
    animRaf: 0,
    animLast: 0,
    /** The element being held, and its offset from the container's top. */
    anchorEl: null as HTMLElement | null,
    anchorOffset: 0,
    /** Which anchor candidates currently sit in the region below the reading line,
     *  so the held element and the nav's active turn both come from observer
     *  callbacks instead of measuring every message on every scroll event. */
    seen: new Set<HTMLElement>(),
    /** Set when THIS client sends; consumed by the turn that send creates. */
    expectSend: false,
    /** The turn this engine has already reacted to, so the arrival branch fires
     *  once per turn rather than once per re-run of its effect. */
    lastTurnKey: undefined as string | undefined,
    /** Whether the transcript has been positioned once. */
    settled: false,
    atRest: false,
    endVisible: true,
    streaming: false,
    /** Last inset READ from the published value. */
    kbInset: 0,
    /** Inset already reflected in the scroll position. The gap between the two is
     *  compensation owed to the reader, deferred while they are driving. */
    kbApplied: 0,
    vvRaf: 0,
    /** While true, `tail` stays valid without a streaming turn — see `restoring`
     *  in the snapshot. Extended by every height change and cancelled the instant
     *  the reader touches anything. */
    restoring: false,
    restoreTimer: null as ReturnType<typeof setTimeout> | null,
    restoreDeadline: 0,
    reserve: 0,
    line: 0,
    reduceMotion: false,
    writeCount: 0,
  });

  const setOwner = useCallback((next: ScrollOwner, source: string) => {
    s.current.source = source;
    if (s.current.owner === next) return;
    s.current.owner = next;
    if (next === "tail") setHasUnseen(false);
  }, []);

  /** Remember where the held element sits now, so the next height change is
   *  measured against it. One rect read, one element. */
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    const a = s.current.anchorEl;
    if (!el || !a?.isConnected) return;
    s.current.anchorOffset = a.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, []);

  /** Single writer. Every path that moves the transcript goes through here, so the
   *  "was that us?" check has exactly one thing to remember — and so the held
   *  element's reference offset is refreshed by construction. */
  const write = useCallback((el: HTMLElement, top: number) => {
    const clamped = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    if (Math.abs(clamped - el.scrollTop) >= 0.5) {
      el.scrollTop = clamped;
      // Counted, not just performed: "no writes happened during that gesture" is an
      // invariant a test can only check against a tally. Costs one increment.
      s.current.writeCount++;
      // Re-anchor after every move WE make. Without this, any engine-driven jump was
      // undone by the settle that followed it: the jump moved the held element, the
      // next pass measured that as drift, and dutifully scrolled back. Movement we
      // performed on purpose is a new reading position, never something to defend
      // against — and putting that here means no caller can forget it.
      captureAnchor();
    }
    s.current.written = el.scrollTop;
  }, [captureAnchor]);

  /** Read the geometry the engine needs. Called only where layout is already clean
   *  (a ResizeObserver callback, a layout effect) so these reads are free — and
   *  always BEFORE any write in the same pass, which is what keeps this off the
   *  forced-reflow path the old code sat on. */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    const cs = getComputedStyle(el);
    // The reading line is not a constant kept in sync with a Tailwind class — it IS
    // the container's top padding, the room reserved under the floating header. Ask
    // the layout instead of duplicating it in JS.
    const line = parseFloat(cs.paddingTop) || 0;
    if (line !== s.current.line) {
      s.current.line = line;
      setReadingLine(line);
    }
    // Fractional, unlike clientHeight. Text heights are fractional, and a rounded
    // viewport height is what let the spacer land exactly on the overflow boundary
    // and flip the scrollbar on and off with every streamed delta.
    const rect = el.getBoundingClientRect();
    const pin = pinRef.current;
    const endRect = contentEndRef.current?.getBoundingClientRect();
    const anchor = s.current.anchorEl;
    const now = performance.now();
    // The hold expires on its own rather than needing a matching "release" call —
    // a component that unmounts mid-animation (a chat switch) can't leave the
    // engine stuck holding an element that no longer exists.
    if (s.current.owner === "interaction" && now > s.current.holdUntil) setOwner("reader", "hold-expired");
    return {
      el,
      top: rect.top,
      snap: {
        owner: s.current.owner,
        height: rect.height,
        line,
        reserveNoKb: s.current.reserve,
        // Includes the keyboard, because "the end of the conversation" means the
        // end of what is VISIBLE. The padding already carries `var(--kb)`, so this
        // reads the one published number rather than recomputing it.
        reserveWithKb: parseFloat(cs.paddingBottom) || 0,
        scrollTop: el.scrollTop,
        pinTop: pin ? pin.getBoundingClientRect().top - rect.top : null,
        contentEndTop: endRect ? endRect.top - rect.top : null,
        contentEndBottom: endRect ? endRect.bottom - rect.top : null,
        spacerH: spacerRef.current ? parseFloat(spacerRef.current.style.height) || 0 : 0,
        anchorNow: anchor?.isConnected ? anchor.getBoundingClientRect().top - rect.top : null,
        anchorWas: s.current.anchorOffset,
        // A finger ON THE GLASS counts, not only one that has already moved the
        // scroller. iOS treats touch as owning the scroller from contact, and a
        // reader holding still mid-read is as much in charge as one mid-swipe — the
        // earlier fix only stopped the idle timer from lying, it did not stop the
        // writes. An ordinary tap costs at most a frame of paused following, and a
        // press on a disclosure writes nothing anyway.
        readerActive: s.current.readerActive || s.current.touchActive,
        animating: s.current.animTo != null,
        streaming: s.current.streaming,
        restoring: s.current.restoring,
        wasEndVisible: s.current.endVisible,
      } satisfies ScrollSnapshot,
    };
  }, [setOwner]);

  const stopAnim = useCallback(() => {
    if (s.current.animRaf) cancelAnimationFrame(s.current.animRaf);
    s.current.animRaf = 0;
    s.current.animTo = null;
  }, []);

  /** Ease toward a target with one writer and one frame loop. Deliberately not
   *  `behavior: "smooth"`: a native smooth scroll emits scroll events carrying
   *  positions we never wrote, and the "was that us?" check would read those as the
   *  reader taking over — cancelling the very move that started it. */
  const animateTo = useCallback((top: number, instant?: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (instant || s.current.reduceMotion || Math.abs(top - el.scrollTop) > TELEPORT_VIEWPORTS * el.clientHeight) {
      stopAnim();
      write(el, top);
      return;
    }
    s.current.animTo = top;
    if (s.current.animRaf) return;
    s.current.animLast = performance.now();
    const step = (now: number) => {
      s.current.animRaf = 0;
      const target = s.current.animTo;
      const node = scrollRef.current;
      if (target == null || !node) return;
      // The reader outranks any animation of ours: hold the target, resume when the
      // finger and its momentum are done.
      if (s.current.readerActive) {
        s.current.animLast = now;
        s.current.animRaf = requestAnimationFrame(step);
        return;
      }
      const dt = Math.min(64, now - s.current.animLast);
      s.current.animLast = now;
      const remaining = target - node.scrollTop;
      if (Math.abs(remaining) < 0.5) {
        write(node, target);
        s.current.animTo = null;
        return;
      }
      write(node, node.scrollTop + easeStep(remaining, dt, EASE_TAU_MS));
      s.current.animRaf = requestAnimationFrame(step);
    };
    s.current.animRaf = requestAnimationFrame(step);
  }, [stopAnim, write]);


  /**
   * Hold the end of a freshly opened chat while it finishes assembling.
   *
   * The window is extended by every height change rather than being a fixed
   * duration, because what we are waiting for is not a deadline but quiet: history
   * arriving, images decoding, the shiki/mermaid chunk re-laying-out the whole
   * transcript. A hard cap stops a perpetually animating message from holding the
   * end forever, and the reader touching anything ends it immediately — from that
   * moment they are the one who decides where the view sits.
   *
   * One function taking an action rather than an extend/end pair: the two halves
   * would otherwise have to reference each other, which is both a forward reference
   * and a way for them to drift apart.
   */
  const restore = useCallback((action: "extend" | "end") => {
    const st = s.current;
    if (!st.restoring) return;
    if (st.restoreTimer) { clearTimeout(st.restoreTimer); st.restoreTimer = null; }
    const finish = () => {
      st.restoring = false;
      st.restoreTimer = null;
      // Hand over to whoever should have it now: a streaming turn keeps being
      // followed, an idle chat becomes the reader's.
      if (st.owner === "tail" && !st.streaming) setOwner("reader", "restored");
    };
    if (action === "extend" && performance.now() <= st.restoreDeadline) {
      st.restoreTimer = setTimeout(finish, RESTORE_QUIET_MS);
      return;
    }
    finish();
  }, [setOwner]);

  /**
   * Lift the reading line clear of the on-screen keyboard.
   *
   * iOS overlays the keyboard without resizing layout, so `--kb` only adds room
   * BELOW — it never lifts what you are looking at, and the line you were reading
   * slips behind the keys. Mirroring the inset into `scrollTop` is what every
   * messenger does. Android resizes layout instead, so the inset stays ~0 there and
   * the container's own resize does the work.
   *
   * Split into "measured" and "applied" because the two can legitimately disagree
   * for a while: the keyboard can appear or dismiss DURING a touch or its momentum,
   * and writing then would break the one invariant this engine has — that nothing
   * writes while the reader is driving. So the delta is banked and flushed the
   * moment control comes back, which is also why this is called from
   * `endReaderControl` as well as from the viewport listener.
   *
   * A driven owner needs no lift at all: following the tail clears the keyboard by
   * itself (the reserve includes it), and a held question belongs on the reading
   * line whether or not the keys are up.
   */
  const applyKeyboardShift = useCallback(() => {
    const st = s.current;
    const el = scrollRef.current;
    if (!el) return;
    if (st.owner !== "reader" || st.readerActive) {
      // Not ours to apply right now. Under a driven owner the position is already
      // correct, so adopt the inset rather than banking a debt that would later be
      // paid into a view that never needed it.
      if (st.owner !== "reader") st.kbApplied = st.kbInset;
      return;
    }
    const delta = st.kbInset - st.kbApplied;
    st.kbApplied = st.kbInset;
    if (Math.abs(delta) <= 1) return;
    // `write` re-anchors, which is what keeps the lift from being read as drift and
    // undone by the settle that follows it.
    write(el, el.scrollTop + delta);
  }, [write]);

  /**
   * The one pass that reacts to a height change, in strict read-then-write order.
   *
   * Runs synchronously inside the ResizeObserver callback — after layout, before
   * paint — so a correction lands in the SAME frame as the change that caused it.
   * Deferring to rAF would paint one uncompensated frame, and one frame of a
   * reasoning block collapsing by 2000px is plainly visible. Because every read
   * happens before every write, layout is dirtied once, at the end of the pass.
   */
  const settle = useCallback(() => {
    const m = measure();
    if (!m) return;
    const plan = planScroll(m.snap);

    // Writes. Spacer first: it changes how far we may scroll, and the clamp inside
    // `write` has to see the new limit. Neither write needs a read — and the no-op
    // guard is load-bearing, since writing the same height back would re-trigger
    // the very observer that called us.
    if (plan.spacerH != null && spacerRef.current) spacerRef.current.style.height = `${plan.spacerH}px`;
    if (plan.owner !== s.current.owner) setOwner(plan.owner, "plan");

    let correction = 0;
    if (plan.target != null) {
      correction = plan.target - m.el.scrollTop;
      if (s.current.animTo != null) s.current.animTo = plan.target;
      else if (plan.motion === "ease") animateTo(plan.target);
      else write(m.el, plan.target);
    } else {
      // Nothing written, but the browser may have clamped the position when content
      // shrank. Adopt it, so the resulting scroll event isn't mistaken for the
      // reader taking over.
      s.current.written = m.el.scrollTop;
    }

    s.current.atRest = plan.atRest;
    restore("extend");
    if (plan.endVisible !== s.current.endVisible) {
      s.current.endVisible = plan.endVisible;
      setEndVisible(plan.endVisible);
      if (plan.endVisible) setHasUnseen(false);
    }
    captureAnchor();

    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __CAPKA_SCROLL__?: DebugState }).__CAPKA_SCROLL__ = {
        owner: s.current.owner,
        source: s.current.source,
        anchor: s.current.anchorEl?.dataset.scrollAnchor ?? null,
        anchorId: s.current.anchorEl?.closest("[data-msg-id]")?.getAttribute("data-msg-id") ?? null,
        candidates: s.current.seen.size,
        atRest: plan.atRest,
        endVisible: plan.endVisible,
        keyboard: publishedKeyboardInset(),
        lastCorrection: Math.round(correction),
        writes: s.current.writeCount,
      };
    }
  }, [measure, setOwner, write, animateTo, captureAnchor, restore]);

  // NOTE ON STABILITY. Everything below subscribes with `settle` in its dependency
  // array rather than through a ref assigned during render (which React forbids) or
  // `useEffectEvent` (which cannot be listed in a dependency array or passed to an
  // observer). Neither is needed: `settle` closes over refs only, and every callback
  // it depends on is itself stable, so its identity never changes and no observer is
  // ever re-subscribed. The freshness `useEffectEvent` exists to provide is already
  // there, via `s.current`.

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { s.current.reduceMotion = mq.matches; };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Synced after commit, never during render. React may begin a render, and then
  // discard it — writing here in the render phase would let a throw-away render
  // change the engine that is still observing the COMMITTED DOM, and a stale
  // `false` is enough to make `tail` stand down a turn early. The settle is part of
  // the same effect because a turn starting or ending changes who should be
  // driving, and nothing else would notice.
  useIsoLayoutEffect(() => {
    s.current.streaming = isStreaming;
    if (enabled) settle();
  }, [isStreaming, enabled, settle]);

  // ── Height changes ─────────────────────────────────────────────────────────
  // One observer for the content AND the container. Content covers every streamed
  // delta, spoiler, image decode and lazy-chunk upgrade; the container covers a
  // window resize, a rotation, and Android resizing layout for its keyboard —
  // which is why there is no `window.resize` listener any more.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    const content = el?.firstElementChild as HTMLElement | null;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled, settle]);

  // ── Who moved the scroller ─────────────────────────────────────────────────
  const endReaderControl = useCallback(() => {
    // `scrollend` fires for programmatic scrolls too, so without this guard our own
    // eased writes would end a gesture on nearly every frame.
    if (!s.current.readerActive || s.current.touchActive) return;
    if (s.current.idleTimer) clearTimeout(s.current.idleTimer);
    s.current.idleTimer = null;
    s.current.readerActive = false;
    const el = scrollRef.current;
    if (el) s.current.written = el.scrollTop;
    captureAnchor();
    // Any keyboard movement that happened mid-gesture was banked rather than
    // written; this is where that debt is settled.
    applyKeyboardShift();
    // Then one pass, which is what decides whether following resumes.
    //
    // Deliberately NOT decided here. `planScroll` already holds that rule — resting
    // at the end, with a turn streaming, and the reader no longer driving — and it
    // evaluates it against geometry read moments earlier. This function used to
    // apply the same rule to the CACHED `atRest`, and `scrollend` can arrive before
    // the frame that refreshes that cache: a reader who scrolled away was judged
    // against where they had been, re-armed on stale data, and dragged back to the
    // end they had just left.
    settle();
  }, [captureAnchor, applyKeyboardShift, settle]);

  const armIdle = useCallback(() => {
    if (s.current.idleTimer) clearTimeout(s.current.idleTimer);
    s.current.idleTimer = setTimeout(() => endReaderControl(), MOMENTUM_IDLE_MS);
  }, [endReaderControl]);

  const onScrollEvent = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The entire input-detection story, in one comparison.
    if (Math.abs(el.scrollTop - s.current.written) > 1) {
      s.current.readerActive = true;
      stopAnim();
      // Their first touch ends any restore in progress: from here the position is
      // theirs, and re-landing at the end would be us overruling them.
      restore("end");
      setOwner("reader", s.current.touchActive ? "touch" : "pointer-or-key");
    }
    s.current.written = el.scrollTop;
    // Only once the finger is up. While it is down the gesture is plainly ongoing
    // even if the content has stopped moving, and declaring it over there is what
    // let a streamed delta jolt the transcript under a resting thumb.
    if (s.current.readerActive && !s.current.touchActive) armIdle();
  }, [stopAnim, setOwner, restore, armIdle]);

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    const st = s.current;

    const onScroll = () => onScrollEvent();
    const onEnd = () => endReaderControl();
    // `touchstart`, not `pointerdown`: a tap on a spoiler is a pointerdown too, and
    // it produces the largest height change in the app. Marking the reader active
    // there would suppress exactly the compensation that moment needs. This flag
    // only gates the idle timer, so a tap that scrolls nothing changes nothing.
    const onTouchStart = () => {
      st.touchActive = true;
      // Stop any eased scroll of ours immediately, WITHOUT claiming ownership: a
      // finger on the glass means the content must stop, but an ordinary tap is not
      // a scroll and must not end up looking like one. Waiting for the first real
      // scroll event (which is what `readerActive` needs) left the transcript
      // gliding under a stationary thumb.
      stopAnim();
    };
    const onTouchEnd = () => { st.touchActive = false; if (st.readerActive) armIdle(); };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onEnd);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onEnd);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      if (st.idleTimer) clearTimeout(st.idleTimer);
    };
  }, [enabled, onScrollEvent, endReaderControl, armIdle, stopAnim]);

  // Scrolling also changes what is at rest and whether the end is on screen, and
  // neither is a height change — so the pass has to run here too. It is the same
  // read-then-write pass; under `reader` with nothing drifting it writes nothing.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; settle(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [enabled, settle]);

  // ── The reading line ───────────────────────────────────────────────────────
  // Anchor candidates are marked `data-scroll-anchor`, at block granularity rather
  // than per message: the spec's own algorithm prefers deeper nodes for exactly the
  // reason that matters here — a change inside a screens-tall message may not move
  // the message's own box while moving the text being read. Two things fall out of
  // one observer: the element we hold, and the nav's active turn.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    const st = s.current;

    const recompute = () => {
      const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-scroll-anchor]"));
      const candidates = nodes.filter((n) => st.seen.has(n));
      // Document order puts an ancestor before its descendants, so walking forward
      // while each next candidate is contained by the current one lands on the
      // deepest marked block nearest the reading line.
      let anchor: HTMLElement | null = candidates[0] ?? null;
      for (let i = 1; anchor && i < candidates.length; i++) {
        if (!anchor.contains(candidates[i])) break;
        anchor = candidates[i];
      }
      // Never override an element pinned by an explicit interaction.
      if (st.owner !== "interaction" && anchor && anchor !== st.anchorEl) {
        st.anchorEl = anchor;
        captureAnchor();
      }
      // The turn being read is the last user message at or before the anchor.
      //
      // Derived from DOM order rather than from remembered geometry on purpose. The
      // obvious implementation — recording, per message, whether its top is above
      // the reading line — is quietly wrong: with the default threshold, an
      // observer is NOT notified merely because an already-intersecting element's
      // top crossed the boundary, so that flag stays false until the whole bubble
      // leaves and the highlight lags a full message behind. The anchor, by
      // contrast, is accurate by construction: entering and leaving the observed
      // region are exactly the callbacks the observer does deliver.
      const upTo = anchor ? nodes.indexOf(anchor) : nodes.length - 1;
      let active: string | null = null;
      let firstUser: string | null = null;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].dataset.role !== "user") continue;
        const id = nodes[i].dataset.msgId ?? null;
        firstUser ??= id;
        if (i <= upTo) active = id;
      }
      setActiveUserId(active ?? firstUser);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.target.isConnected) st.seen.add(e.target as HTMLElement);
          else st.seen.delete(e.target as HTMLElement);
        }
        recompute();
      },
      // The observed region starts at the reading line, so "intersecting" means "at
      // or below the line, and visible".
      { root: el, rootMargin: `-${Math.round(readingLine)}px 0px 0px 0px` },
    );

    const watched = new Set<HTMLElement>();
    for (const node of el.querySelectorAll<HTMLElement>("[data-scroll-anchor]")) {
      io.observe(node);
      watched.add(node);
    }
    recompute();
    return () => {
      io.disconnect();
      for (const node of watched) st.seen.delete(node);
    };
  }, [enabled, messageCount, readingLine, captureAnchor]);

  // ── Footer height → the room reserved at the foot ───────────────────────────
  // One measured element, no arithmetic: the footer already IS the gradient band
  // plus the composer, and it grows on its own with attachments, the send queue and
  // the error banner. This is what retires `composerH + 16`, the `+ 120` the jump
  // button carried, and the 160px seed the old code had to guess with.
  useIsoLayoutEffect(() => {
    if (!enabled) return;
    const footer = footerRef.current;
    if (!footer) return;
    const apply = () => {
      const next = footer.offsetHeight;
      if (next === s.current.reserve) return;
      s.current.reserve = next;
      setBottomReserve(next);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [enabled]);

  // The reserve feeds `paddingBottom`, so settle only once React has committed it —
  // otherwise a grow is clamped for lack of room. Under `reader` the anchor keeps
  // the reading line steady across the change, which is what the old hand-rolled
  // `scrollTop += delta` was approximating one case at a time.
  useIsoLayoutEffect(() => {
    if (enabled) settle();
  }, [enabled, bottomReserve, settle]);

  // ── Turns ──────────────────────────────────────────────────────────────────
  useIsoLayoutEffect(() => {
    if (!enabled || !turnKey) return;
    // Guard on the turn key actually being NEW, not on this effect having re-run.
    // Anything else in the dependency array — `isStreaming` was the one that bit —
    // re-runs the body with an unchanged turn, and the arrival branch at the bottom
    // then announced "new message" for a turn that had merely finished streaming.
    // Making the body idempotent is the fix; trimming the dependencies is only the
    // belt to its braces.
    if (s.current.lastTurnKey === turnKey) return;
    s.current.lastTurnKey = turnKey;

    // Our own send is the only thing that takes the pin — checked before the
    // first-paint branch, because the very first turn of a brand-new chat is both
    // at once and it should pin, not jump.
    if (s.current.expectSend) {
      s.current.expectSend = false;
      s.current.settled = true;
      setOwner("pin", "send");
      settle();
      const m = measure();
      if (m?.snap.pinTop != null) animateTo(m.el.scrollTop + m.snap.pinTop - m.snap.line);
      return;
    }

    // First positioning of a chat: land at the end, with no motion. Opening a
    // conversation should show where it got to, the way opening any chat does — and
    // a turn resumed mid-stream is then followed for free.
    if (!s.current.settled) {
      s.current.settled = true;
      s.current.restoring = true;
      s.current.restoreDeadline = performance.now() + RESTORE_MAX_MS;
      setOwner("tail", "first-paint");
      settle();
      const m = measure();
      if (m) {
        const o = (m.snap.contentEndBottom ?? 0) - (m.snap.height - m.snap.reserveWithKb);
        animateTo(m.el.scrollTop + o, true);
      }
      return;
    }

    // A turn that simply appeared — Telegram, an automation, another tab. Never pull
    // the screen off what someone is reading; offer it instead.
    if (s.current.owner !== "tail" && !s.current.endVisible) setHasUnseen(true);
  }, [enabled, turnKey, measure, animateTo, setOwner, settle]);

  // ── The visual viewport ────────────────────────────────────────────────────
  // iOS overlays the keyboard without resizing layout, so `--kb` only adds room
  // BELOW — it never lifts what you are looking at, and the line you were reading
  // slips behind the keys. Mirror the inset into `scrollTop` so the list rises with
  // it, the way every messenger does. Android resizes layout instead, so the inset
  // stays ~0 there and the container's own resize does the work.
  //
  // The inset is READ, never recomputed: `publishedKeyboardInset` returns the exact
  // number the padding is using. The engine used to compute its own — omitting
  // `offsetTop` and the small-value snap — so on iOS it lifted the transcript by a
  // different amount than the layout had reserved, which is a shift with nothing
  // underneath it. `scroll` matters as much as `resize`: panning the visual viewport
  // over a focused field moves `offsetTop` without changing its height.
  const onViewportChange = useCallback(() => {
    // One rAF for the whole burst. iOS fires `resize` and `scroll` on the visual
    // viewport repeatedly through a keyboard animation, and a rAF per event meant
    // several complete measure-and-settle passes inside a single frame.
    if (s.current.vvRaf) return;
    s.current.vvRaf = requestAnimationFrame(() => {
      s.current.vvRaf = 0;
      // Read, don't recompute: `publishedKeyboardInset` returns the exact number the
      // padding is using. The engine used to carry its own copy of the formula —
      // omitting `offsetTop` and the small-value snap — so on iOS it lifted the
      // transcript by a different amount than the layout had reserved.
      s.current.kbInset = publishedKeyboardInset();
      applyKeyboardShift();
      settle();
    });
  }, [applyKeyboardShift, settle]);

  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const st = s.current;
    const on = () => onViewportChange();
    vv.addEventListener("resize", on);
    // `scroll` matters as much as `resize`: panning the visual viewport over a
    // focused field moves `offsetTop` without changing its height.
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
      if (st.vvRaf) cancelAnimationFrame(st.vvRaf);
    };
  }, [enabled, onViewportChange]);

  useEffect(() => stopAnim, [stopAnim]);

  const actions = useMemo<ChatScrollActions>(() => ({
    armForSend: () => { s.current.expectSend = true; },
    pinLatest: () => {
      setOwner("pin", "regenerate");
      settle();
      const m = measure();
      if (m?.snap.pinTop != null) animateTo(m.el.scrollTop + m.snap.pinTop - m.snap.line);
    },
    holdInteraction: (trigger, holdMs) => {
      const el = scrollRef.current;
      if (!el) return;
      // How long the panel actually animates, read from the one token the CSS
      // transition also uses. The panel does not exist yet when a CLOSED one is
      // pressed, so its duration cannot be measured off the element — a shared
      // token is the only thing that keeps the two from drifting apart. Doubled,
      // because over-holding is harmless (the anchor is the safe default) while
      // under-holding hands the drive back mid-animation.
      const dur = holdMs ?? (parseFloat(getComputedStyle(el).getPropertyValue("--collapse-dur")) || 0);
      s.current.holdUntil = performance.now() + Math.max(2 * dur, 120);
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        s.current.anchorEl = trigger;
        captureAnchor();
      }
      stopAnim();
      setOwner("interaction", "disclosure");
    },
    jumpToBottom: () => {
      const m = measure();
      if (!m) return;
      // Ownership first, so the eased scroll and any settle landing mid-flight
      // agree on where they are going.
      setOwner(s.current.streaming ? "tail" : "reader", "jump-to-bottom");
      const o = (m.snap.contentEndBottom ?? 0) - (m.snap.height - m.snap.reserveWithKb);
      animateTo(m.el.scrollTop + o);
    },
    jumpToMessage: (id: string) => {
      const m = measure();
      const target = m?.el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
      if (!m || !target) return;
      // An explicit jump leaves the reader in charge: put them where they asked and
      // stop driving. The target becomes what we hold, which is what the anchoring
      // spec does for a fragment navigation.
      s.current.anchorEl = target;
      setOwner("reader", "navigation");
      animateTo(m.el.scrollTop + (target.getBoundingClientRect().top - m.top) - m.snap.line);
    },
  }), [measure, animateTo, setOwner, captureAnchor, stopAnim, settle]);

  return {
    scrollRef, pinRef, contentEndRef, spacerRef, footerRef,
    bottomReserve,
    // The pill is about the end of the conversation, so it never shows while the
    // end is on screen — and an unseen turn always shows, whatever is driving.
    showJump: !endVisible || hasUnseen,
    jumpTone: hasUnseen ? "new" : isStreaming ? "live" : "idle",
    activeUserId,
    actions,
  };
}
