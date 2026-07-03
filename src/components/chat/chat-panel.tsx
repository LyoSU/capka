"use client";

import { useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { nanoid } from "nanoid";

// useLayoutEffect warns during SSR; this client component is still rendered on
// the server, so fall back to useEffect there. The choice is stable per render.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Clearance below the floating gradient header where a pinned turn comes to
// rest (kept in sync with the scroll container's pt-16). Content above this
// line is what the header gradient fades out.
const TOP_INSET = 64;

/** Plain text of a message — the user turns feed the chat navigator. */
function msgText(m: { parts?: { type: string; text?: string }[] }): string {
  return (m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

import { AlertCircle, ArrowDown, FolderOpen, RefreshCw, Send, Clock, X, Square } from "lucide-react";
import { ChatMessage } from "@/components/chat/message";
import { TaskStatus } from "@/components/chat/task-status";
import { ChatInput } from "@/components/chat/chat-input";
import { useFolderSync } from "@/components/chat/use-folder-sync";
import { deriveContextFill } from "@/lib/chat/context/fill";
import { useComposerAttachments } from "@/components/chat/use-composer-attachments";
import { useChatDraft } from "@/components/chat/use-chat-draft";
import { useChatQueue } from "@/components/chat/use-chat-queue";
import type { FileRef } from "@/lib/constants";
import { FileDropZone } from "@/components/chat/file-drop-zone";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspacePanel } from "@/components/chat/workspace-panel";
import { PreviewProvider } from "@/components/chat/file-preview";
import { FileTypeSuggestions } from "@/components/chat/file-type-suggestions";
import { RecentChats } from "@/components/chat/recent-chats";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useBackgroundChat } from "@/hooks/use-background-chat";
import { ChatNav } from "@/components/chat/chat-nav";
import { ClawMark } from "@/components/brand/claw-mark";
import { pickGreeting, type GreetingLocale } from "@/lib/chat/greeting";
import { haptic } from "@/lib/haptics";

interface ChatPanelProps {
  chatId: string;
  defaultModel: string;
  projectId?: string;
  isAdmin?: boolean;
  /** Telegram-sourced chats are read-only on the web — no composer, no edits;
   *  the user replies from Telegram or forks the chat to continue here. */
  readOnly?: boolean;
  /** Server-known: does this chat already have messages? Lets first paint pick
   *  the message-stream shell over the new-chat greeting while history loads. */
  initialHasHistory?: boolean;
  /** Server-rendered recent chats for the greeting's quick-resume list, so it
   *  paints correct immediately instead of fetching and popping in. */
  recentChats?: { id: string; title: string | null; updatedAt: string | null }[];
  /** The signed-in user's display name — woven into the new-chat greeting. */
  userName?: string | null;
}

export function ChatPanel({ chatId, defaultModel, projectId, isAdmin, readOnly, initialHasHistory, recentChats, userName }: ChatPanelProps) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const [model, setModel] = useState(defaultModel);

  // Whether the chat's selected model is still serveable. The model picker
  // resolves this against the live model list (provider disconnected, or the
  // model removed from the catalog → not available). Default available:true so
  // we never block before the list settles. When it settles unavailable, the
  // composer is replaced with a "pick another model" notice — sending to a dead
  // model just produces a failed turn, so we stop it at the source.
  const [modelStatus, setModelStatus] = useState<{ settled: boolean; available: boolean }>({ settled: false, available: true });
  const handleModelResolved = useCallback((s: { settled: boolean; available: boolean }) => setModelStatus(s), []);

  // The new-chat greeting varies by local time and weaves in the user's name,
  // so it's random + timezone-dependent — compute it on the client after mount
  // to avoid an SSR hydration mismatch (the static fallback shows until then).
  // Keyed on chatId so each fresh chat is re-picked and feels freshly addressed.
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => {
    setGreeting(pickGreeting({ name: userName, locale: locale as GreetingLocale }));
  }, [chatId, userName, locale]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The latest user message ("the question"), the end of real content (before
  // the spacer), and the spacer itself — together they let us pin a turn to the
  // top the way ChatGPT/Claude do.
  const lastUserMsgRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // Whether we're still holding the latest turn at the top. True right after a
  // send; the user taking manual scroll control (wheel/touch/nav) releases it.
  const pinnedRef = useRef(true);
  // First paint of a chat snaps into place instantly; later sends animate. The
  // page mounts ChatPanel with key={chatId}, so this resets per chat for free.
  const seenFirstTurn = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  // The user turn currently at the top of the view — highlighted in the nav.
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  // The composer floats over the scroll area as an overlay, so the scroll area
  // reserves bottom room equal to the composer's live height. Attaching files
  // grows the composer; a fixed inset would then hide the tail of the reply
  // behind it with nowhere to scroll. Measured here and fed into paddingBottom.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(160);
  // Carries a height delta from the ResizeObserver to a layout effect that
  // applies the matching scroll shift — done after the new padding commits so
  // the room exists and a grow-shift isn't clamped. prevComposerH lets the
  // observer compute the delta without re-measuring.
  const pendingShift = useRef(0);
  const prevComposerH = useRef(160);

  const router = useRouter();
  const { messages, isLoading, error, sendMessage, regenerate, editMessage, switchBranch, forkChat, stop, ensureChat, reload, awaitingInput, taskInfo } = useBackgroundChat({
    chatId,
    projectId,
  });
  // Composer attachments upload eagerly on attach (so send is instant and a
  // retry never re-uploads) and persist their refs per chat — they survive a
  // reload just like the text draft.
  const attachments = useComposerAttachments({ chatId, ensureChat });
  // PC folders (File System Access): pushed before a message, pulled after the
  // turn. A no-op when the chat has no connected folders, so it costs nothing on
  // the common path.
  const folderSync = useFolderSync({ chatId, ensureChat });

  // Fork the conversation from a message into a fresh chat, then jump to it.
  // useCallback keeps this identity stable across composer keystrokes so it
  // doesn't defeat memo(ChatMessage) and re-render the whole transcript.
  const handleFork = useCallback(async (messageId: string) => {
    const newId = await forkChat(messageId);
    if (newId) router.push(`/chat/${newId}`);
    else toast.error(t("forkFailed"));
  }, [forkChat, router, t]);

  // Stable identities for the same reason as handleFork — these are passed to
  // every ChatMessage even while a turn runs (the buttons render disabled, not
  // hidden — see actionsDisabled), so a changing identity would bust the memo.
  const handleEdit = useCallback((id: string, text: string) => editMessage(id, text, model), [editMessage, model]);
  const handleRegenerate = useCallback(() => regenerate(model), [regenerate, model]);

  // "Continue here": fork a read-only Telegram chat from its latest message into
  // a fresh, fully-interactive web chat so the user can take the thread over.
  const handleContinueHere = async () => {
    const lastId = messages[messages.length - 1]?.id;
    if (!lastId) return;
    await handleFork(lastId);
  };

  // The latest assistant reply is the only one that can be regenerated; editing
  // is offered on any user message. While a turn is streaming the actions render
  // disabled instead of unmounting — vanishing icons read as the UI glitching.
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  })();

  // The message that starts the latest turn. Changing this (a new send, or
  // opening a chat) is what triggers the pin-to-top animation.
  const lastUserId = messages.findLast((m) => m.role === "user")?.id;

  // Context-window fill for the composer meter (hidden below 50%, and hidden
  // right after a compaction until the next turn re-measures).
  const contextUsage = deriveContextFill(messages);

  // One nav entry per user turn — the minimap down the right edge.
  const navItems = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ id: m.id, text: msgText(m as { parts?: { type: string; text?: string }[] }) }));

  // Show the "scroll to latest" button only when streamed content has grown
  // past the visible reading area (the input bar floats over the bottom ~120px).
  const updateScrollDown = () => {
    const el = scrollRef.current;
    const end = contentEndRef.current;
    if (!el || !end) return;
    const cRect = el.getBoundingClientRect();
    const eRect = end.getBoundingClientRect();
    setShowScrollDown(eRect.bottom > cRect.bottom - 120);
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    const end = contentEndRef.current;
    if (!el || !end) return;
    pinnedRef.current = false; // explicit navigation — stop holding the turn at top
    const cRect = el.getBoundingClientRect();
    const eRect = end.getBoundingClientRect();
    el.scrollTo({ top: el.scrollTop + (eRect.bottom - cRect.bottom) + 120, behavior: "smooth" });
  };

  // Bring any message (by id) to rest just below the header — powers the nav.
  const scrollToMessage = (id: string) => {
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!el || !target) return;
    pinnedRef.current = false; // user navigated to a specific turn — release the pin
    const top = el.scrollTop + (target.getBoundingClientRect().top - el.getBoundingClientRect().top) - TOP_INSET;
    el.scrollTo({ top, behavior: "smooth" });
  };

  // The active turn is the last user message whose top has reached the header
  // line — i.e. the one you're currently reading.
  const updateActiveTurn = () => {
    const el = scrollRef.current;
    if (!el) return;
    const cTop = el.getBoundingClientRect().top;
    const nodes = el.querySelectorAll<HTMLElement>('[data-role="user"]');
    let active: string | null = nodes[0]?.dataset.msgId ?? null;
    nodes.forEach((n) => {
      if (n.getBoundingClientRect().top - cTop <= TOP_INSET + 8) active = n.dataset.msgId ?? active;
    });
    setActiveUserId(active);
  };

  const handleScroll = () => { updateScrollDown(); updateActiveTurn(); };

  // Size the spacer to exactly the room still missing for the latest user
  // message to reach the top — i.e. one viewport minus whatever already sits
  // below it (its reply + status). As the reply streams in, this shrinks toward
  // zero, so a long answer leaves no dead space; a short one still pins to top.
  const resizeSpacer = () => {
    const el = scrollRef.current;
    const userEl = lastUserMsgRef.current;
    const end = contentEndRef.current;
    const spacer = spacerRef.current;
    if (!el || !userEl || !end || !spacer) return;
    const contentBelowUser = end.getBoundingClientRect().top - userEl.getBoundingClientRect().top;
    // Subtract the composer's own footer (its live height + the 16px of air) —
    // the scroll area already reserves exactly that as paddingBottom. Counting
    // only the viewport here would stack the two and leave a composer-tall band
    // of dead scroll below the turn. (--kb is left in the padding on purpose:
    // that slack is what lets the list rise above the on-screen keyboard.)
    const footer = prevComposerH.current + 16;
    const h = `${Math.max(0, el.clientHeight - footer - contentBelowUser - TOP_INSET)}px`;
    // Only write when it actually changes — a no-op write would re-trigger the
    // ResizeObserver that calls this, risking a feedback loop.
    if (spacer.style.height !== h) spacer.style.height = h;
  };

  // Pin the latest turn to the top. When a new user message appears we grow the
  // bottom spacer (so a short reply can still be scrolled up), then bring the
  // message to the top. The reply streams downward into the space below — we
  // never auto-follow it, so the view stays calm while the model writes.
  useIsomorphicLayoutEffect(() => {
    if (!lastUserId) return;
    const el = scrollRef.current;
    const userEl = lastUserMsgRef.current;
    if (!el || !userEl) return;

    resizeSpacer(); // synchronous style write — layout is ready before we scroll
    const cRect = el.getBoundingClientRect();
    const uRect = userEl.getBoundingClientRect();
    const top = el.scrollTop + (uRect.top - cRect.top) - TOP_INSET;
    // "instant" (not "auto") — "auto" defers to the CSS scroll-behavior, which
    // would animate the very first positioning and read as a stray scroll.
    el.scrollTo({ top, behavior: seenFirstTurn.current ? "smooth" : "instant" });
    seenFirstTurn.current = true;
    pinnedRef.current = true; // a fresh turn re-arms the pin
    updateScrollDown();
    updateActiveTurn();
  }, [lastUserId]);

  // Hold the latest turn at the top through ANY content height change — not just
  // message additions. A long reasoning block collapsing on its own shrinks the
  // reply; without this the browser clamps the scroll and the question visibly
  // drops down the page. We keep the spacer sized and, while the pin is still
  // held (the user hasn't grabbed scroll), re-seat the question at the header
  // line. Wheel/touch release the pin so we never fight a deliberate scroll.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild as HTMLElement | null;
    if (!el || !content) return;

    const release = () => { pinnedRef.current = false; };
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchmove", release, { passive: true });

    const ro = new ResizeObserver(() => {
      resizeSpacer(); // grow the spacer first so re-seating has room to scroll into
      if (pinnedRef.current) {
        const userEl = lastUserMsgRef.current;
        if (userEl) {
          const top = el.scrollTop + (userEl.getBoundingClientRect().top - el.getBoundingClientRect().top) - TOP_INSET;
          if (Math.abs(top - el.scrollTop) > 1) el.scrollTop = top; // instant re-seat, no animation
        }
      }
      updateScrollDown();
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchmove", release);
    };
  }, []);

  // Keep the spacer correct on viewport changes; refresh the button as the
  // reply streams in (content grows, but we deliberately don't scroll).
  useEffect(() => {
    const onResize = () => { resizeSpacer(); updateScrollDown(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Glue the conversation to the rising keyboard. iOS overlays the on-screen
  // keyboard without resizing layout, so the --kb padding only adds room *below*
  // — it never lifts what you're looking at, and the newest message slips behind
  // the keyboard. Mirror the keyboard's height change into scrollTop so the list
  // moves up in lockstep with it, the way every messenger does: your position
  // (latest reply, or mid-history) is preserved, just raised above the keyboard —
  // expected, not a jump. Deferred to a frame so useKeyboardInset's matching
  // padding bump has committed first; otherwise the scroll would clamp for lack
  // of room. Android resizes layout instead (inset stays ~0), so this is a no-op.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevInset = Math.max(0, window.innerHeight - vv.height);
    const onResize = () => {
      const inset = Math.max(0, window.innerHeight - vv.height);
      const delta = inset - prevInset;
      prevInset = inset;
      if (Math.abs(delta) <= 1) return;
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop += delta;
      });
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // As the reply streams in, keep the spacer trimmed to just-enough and refresh
  // the button + active turn. Deferred to a frame so we measure after the new
  // content has laid out (and so the state writes aren't synchronous in-effect).
  useEffect(() => {
    const raf = requestAnimationFrame(() => { resizeSpacer(); updateScrollDown(); updateActiveTurn(); });
    return () => cancelAnimationFrame(raf);
  }, [messages]);

  // A gentle "done" buzz on the falling edge of loading (touch devices only).
  const wasLoading = useRef(false);
  useEffect(() => {
    if (wasLoading.current && !isLoading) {
      haptic("success");
      // Turn finished — pull any files the agent changed back to the local folder.
      void folderSync.pullAll();
    }
    wasLoading.current = isLoading;
  }, [isLoading, folderSync]);

  // Composer text is a per-chat draft persisted to localStorage, so a
  // typed-but-unsent message survives a reload, a closed tab, or a failed send.
  const { draft: input, setDraft: setInput, clearDraft } = useChatDraft(chatId);
  // Messages typed while a reply is streaming wait here (shown above the
  // composer, each cancellable) and are dispatched one-by-one as the chat frees
  // up — held client-side so they can be edited/removed before they're sent.
  // Persisted per-chat to localStorage so the queue survives the `key={chatId}`
  // remount on a chat switch (the in-memory version was dropped on the floor).
  const { queued, setQueued } = useChatQueue(chatId);
  const dispatchingRef = useRef(false);
  // Synchronous "a direct send is in flight" guard. `isLoading` is React state
  // and only flips to running on the next committed render, so for the brief
  // window between starting `send()` and that commit it still reads false — a
  // fast second submit would slip past the busy-check and fire a SECOND
  // concurrent send instead of queuing as the next turn. This ref closes that
  // window the way `dispatchingRef` already does for the drain loop.
  const sendingRef = useRef(false);

  const send = async (text: string, refs: FileRef[], id?: string): Promise<boolean> => {
    try {
      // Push local folder changes up before the turn sees the workspace. Never
      // block the send on it — a sync hiccup shows in the chip, not a failed turn.
      await folderSync.pushAll().catch(() => {});
      await sendMessage(text, model, refs.length > 0 ? refs : undefined, id);
      return true;
    } catch (e) {
      // The send failed and the hook already rolled back its optimistic bubble —
      // put the user's words back in the composer so nothing they typed is lost.
      // If they've since started a new message, keep both: the failed text goes
      // on top (filter drops empties so a files-only failure adds no blank lines).
      // The attachments are still in the sandbox, so restore re-adds them as ready
      // chips (deduped). The updater reads the live draft, not this closure's
      // stale snapshot (matters for queued sends).
      setInput((cur) => [text, cur].filter(Boolean).join("\n\n"));
      attachments.restore(refs);
      toast.error(e instanceof Error ? e.message : t("panel.sendFailed"));
      return false;
    }
  };

  // Stable sender for manage cards' confirm/undo buttons — kept referentially
  // stable (via a ref to the latest `send`) so it doesn't bust ChatMessage's memo
  // and re-render the whole transcript on every keystroke.
  const sendRef = useRef(send);
  sendRef.current = send;
  const handleManageSend = useCallback((text: string) => {
    void sendRef.current(text, []);
  }, []);

  const handleSubmit = async () => {
    const text = input.trim();
    const refs = attachments.readyRefs;
    // Nothing to send, or an attachment is still uploading (send is disabled in
    // the composer while uploading, but guard here too).
    if ((!text && refs.length === 0) || attachments.hasUploading) return;
    haptic("tap"); // light confirmation that the message left
    clearDraft(); // sent — drop the persisted draft so a reload won't restore it
    attachments.clear(); // forget the chips; the sent message owns the files now
    // A turn is already running, queued items are still draining, or a direct
    // send we just kicked off hasn't flipped isLoading yet — line this one up
    // instead of sending now. `sendingRef` is the synchronous part of that
    // check: it's true the instant a send starts, so a fast second submit
    // queues as the next turn rather than racing out as a concurrent send.
    if (isLoading || queued.length > 0 || dispatchingRef.current || sendingRef.current) {
      // nanoid (not crypto.randomUUID, which is undefined on non-secure origins)
      // — and this id rides through the drain into the POST as the message id, so
      // a double-drain (same chat in two tabs) collapses server-side.
      setQueued((q) => [...q, { id: nanoid(), text, refs }]);
      return;
    }
    // Hold the guard until the POST resolves — by then sendMessage's
    // setStatus("running") has committed, so isLoading takes over seamlessly
    // (on failure send() rolls back to idle and the guard simply releases).
    sendingRef.current = true;
    try {
      await send(text, refs);
    } finally {
      sendingRef.current = false;
    }
  };

  // Drain the queue when the chat frees up: send each queued message as its own
  // message (separate bubbles, just as the user typed them) — the server folds
  // the whole burst into a single reply. Sent sequentially so they chain in
  // order; the ref guards the async gap before isLoading flips.
  useEffect(() => {
    if (isLoading || dispatchingRef.current || queued.length === 0) return;
    const batch = queued;
    dispatchingRef.current = true;
    void (async () => {
      for (const item of batch) {
        // Dequeue this one as we start it — NOT the whole batch up-front. A reload
        // mid-drain then keeps the not-yet-started items in localStorage (the
        // whole point of persisting the queue), and the stable id keeps the
        // in-flight one idempotent if it raced through to the server.
        setQueued((q) => q.filter((m) => m.id !== item.id));
        const ok = await send(item.text, item.refs, item.id);
        // A hard failure put the text back in the composer; stop the burst rather
        // than hammering a failing server — the rest stay queued and re-drain when
        // the chat is free, one attempt each (no retry loop: each is dequeued).
        if (!ok) break;
      }
    })().finally(() => { dispatchingRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, queued]);

  // Show the new-chat greeting ONLY for a genuinely fresh chat. `messages` start
  // empty until the hook's history fetch resolves, so `messages.length === 0`
  // alone can't tell a new chat from an existing one mid-load — that conflation
  // is what flashed the greeting on direct navigation. `initialHasHistory` is the
  // server's authoritative answer (chat.activeLeafId != null), so an existing
  // chat renders the stream shell from first paint; the `messages.length` guard
  // keeps the greeting from lingering after the first send on a truly new chat.
  const showGreeting = !initialHasHistory && messages.length === 0;
  const [filesOpen, setFilesOpen] = useState(false);

  // Track the composer's height so the scroll inset always matches it. Re-run
  // when the greeting gives way to the message stream, since the composer only
  // mounts there. The initial measurement seeds prevComposerH WITHOUT queuing a
  // shift (first paint shouldn't jump); subsequent growth/shrink (a file chip
  // appearing, the queue filling) queues the delta.
  useIsomorphicLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    prevComposerH.current = el.offsetHeight;
    setComposerH(el.offsetHeight);
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const delta = h - prevComposerH.current;
      if (!delta) return;
      prevComposerH.current = h;
      pendingShift.current += delta;
      setComposerH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showGreeting]);

  // Once the padding (driven by composerH) has committed, apply the queued
  // scroll delta: the content shifts by exactly the composer's growth, so the
  // last line you were reading stays glued to the composer's top edge instead
  // of being swallowed by it.
  useIsomorphicLayoutEffect(() => {
    const d = pendingShift.current;
    if (!d) return;
    pendingShift.current = 0;
    const el = scrollRef.current;
    if (el) el.scrollTop += d;
  }, [composerH]);

  // A monotonically-rising count of completed tool calls across the whole thread.
  // It ticks up the moment a tool finishes — exactly when the agent may have
  // written or changed files — so the workspace panel refreshes in real time.
  const toolRevision = messages.reduce(
    (n, m) =>
      n +
      ((m.parts as { type: string; state?: string }[] | undefined)?.filter(
        (p) => p.type === "dynamic-tool" && (p.state === "output-available" || p.state === "output-error"),
      ).length ?? 0),
    0,
  );

  // A failed assistant message renders its own ErrorNotice — don't also show
  // the bottom banner for the same failure (the banner stays for load errors).
  const lastMsg = messages[messages.length - 1];
  const lastFailed = (lastMsg?.metadata as { taskStatus?: string } | undefined)?.taskStatus === "failed";

  // The chat's model is gone and nothing is currently streaming — swap the
  // composer for a notice that explains why and lets the user pick another model
  // to continue right here (or start fresh). Held off while a turn is still
  // running so the composer keeps its stop button.
  const modelGone = !readOnly && !isLoading && modelStatus.settled && !modelStatus.available;

  const inputEl = readOnly ? (
    <div className="mx-auto max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6 lg:max-w-4xl">
      <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card/50 px-4 py-5 text-center">
        {isLoading ? (
          // The bot (started from Telegram) is actively working on this read-only
          // chat. We can't reply here, but the running task is the same row a web
          // send would create — so the already-wired stop() cancels it all the same.
          <>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="spinner-ring h-3.5 w-3.5 animate-spin rounded-full" aria-hidden="true" />
              {t("panel.telegramBusy")}
            </p>
            <Button variant="outline" size="sm" onClick={stop}>
              <Square className="h-3.5 w-3.5" />
              {t("panel.stopBot")}
            </Button>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Send className="h-4 w-4 shrink-0" />
              {t("panel.telegramReadOnly")}
            </p>
            <Button variant="outline" size="sm" onClick={handleContinueHere} disabled={messages.length === 0}>
              {t("panel.continueHere")}
            </Button>
          </>
        )}
      </div>
    </div>
  ) : modelGone ? (
    <div className="mx-auto max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6 lg:max-w-4xl">
      {/* Calm, centered — matches the read-only block above. No inline picker: it
          rendered awkwardly in this floating block, and the header picker already
          fixes it (picking an available model flips modelStatus and the composer
          returns). One line says what to do; the button offers the alternative. */}
      <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card/50 px-4 py-5 text-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {t("panel.modelGoneBody")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push(projectId ? `/chat?projectId=${projectId}` : "/chat")}
        >
          {t("panel.modelGoneNew")}
        </Button>
      </div>
    </div>
  ) : (
    <ChatInput
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      onStop={stop}
      isLoading={isLoading}
      awaitingInput={awaitingInput}
      chatId={chatId}
      files={attachments.files}
      onAddFiles={attachments.add}
      onRemoveFile={attachments.remove}
      onRetryFile={attachments.retry}
      contextUsage={contextUsage}
      isNewChat={showGreeting}
      folders={folderSync}
    />
  );

  // Pending messages waiting their turn, shown just above the composer. The ×
  // removes one before it's sent; the clock makes clear it runs later.
  const queuedEl = queued.length > 0 ? (
    <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1.5 px-4 md:px-6 lg:max-w-4xl">
      {queued.map((q) => (
        <div
          key={q.id}
          className="flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 text-sm shadow-sm"
        >
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-foreground/90">
            {q.text || t("panel.queuedFiles", { count: q.refs.length })}
          </span>
          <button
            type="button"
            onClick={() => setQueued((qq) => qq.filter((x) => x.id !== q.id))}
            aria-label={t("panel.cancelQueued")}
            className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <PreviewProvider>
    {/* Full-window drop target — disabled for read-only Telegram chats (no composer). */}
    <FileDropZone onFiles={attachments.add} disabled={readOnly} />
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
      {showGreeting ? (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {/* No header in the greeting state, so the sidebar handle lives in the
              top-left corner on mobile. Pinned outside the scroll area so it
              stays put while the greeting scrolls under it on short screens. */}
          <SidebarTrigger className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 size-9 rounded-full border bg-card shadow-sm md:hidden" />
          {/* Scroll wrapper: the inner block centers when it fits (min-h-full +
              justify-center) and scrolls when the greeting is taller than the
              viewport — otherwise centering clips the logo off the top with no
              way to scroll back to it (mobile, keyboard open). */}
          <div
            className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]"
            // Keyboard inset as bottom padding so the centered composer rises above
            // the keyboard instead of being covered (iOS).
            style={{ paddingBottom: "calc(2.5rem + var(--kb, 0px))" }}
          >
          <div className="flex min-h-full flex-col items-center justify-center py-10">
          <div className="relative z-10 w-full">
            {/* The brand claw reveals on mount — the one signature flourish — with
                a soft halo lifting it off the surface, then the greeting floats up
                just behind it. */}
            <div className="mb-8 flex flex-col items-center px-6">
              <div className="relative">
                <div
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--foreground)_8%,transparent),transparent_70%)]"
                />
                <ClawMark animated className="relative h-20 w-20 text-foreground md:h-24 md:w-24" />
              </div>
              <h1 className="animate-claw-greet mt-6 font-display text-balance text-center text-fluid-display font-medium tracking-tight text-foreground">
                {greeting ?? t("panel.greeting")}
              </h1>
            </div>

            <div className="animate-blur-rise [animation-delay:80ms]">{inputEl}</div>

            <div className="mx-auto max-w-3xl px-4 md:px-6 lg:max-w-4xl">
              {/* relative z-20 keeps the picker (and its absolute dropdown) in a
                  stacking context above the starters block below — otherwise the
                  later sibling paints over the open dropdown. */}
              <div className="animate-blur-rise relative z-20 -mt-3 flex justify-center [animation-delay:140ms]">
                <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
                  <ModelPicker variant="pill" value={model} onChange={setModel} />
                </div>
              </div>
              {/* Hint + recent + starters collapse away the moment the user starts
                  typing. Animating grid-rows 1fr→0fr (not unmounting) shrinks the
                  height over 300ms, so the centered composer above glides to its
                  new center instead of snapping. `inert` drops the hidden controls
                  from tab/click order; the global reduced-motion rule flattens the
                  transition to instant. */}
              <div
                className={`grid transition-all duration-300 ease-out ${
                  input ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                }`}
                inert={input ? true : undefined}
              >
                <div className="overflow-hidden">
                  <div className="animate-blur-rise pt-2.5 [animation-delay:200ms]">
                    <p className="text-center text-xs text-muted-foreground">{t("panel.greetingHint")}</p>
                    <div className="mt-8 space-y-6">
                      <RecentChats initial={recentChats} />
                      <FileTypeSuggestions onPick={setInput} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {/* Scroll area fills the whole panel; the header and input float over
              it as gradients, so messages slide behind a soft fade at both ends.
              both-edges keeps the centered column aligned with those overlays
              (which don't know about the gutter) whether or not a classic
              scrollbar is showing. */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto overscroll-contain pt-16 [scrollbar-gutter:stable_both-edges]"
            // Bottom room tracks the composer's live height (+a little air, +the
            // keyboard inset) so the last message always clears the overlaid
            // composer — even after attachments grow it.
            style={{ paddingBottom: `calc(${composerH + 16}px + var(--kb, 0px))` }}
          >
            <div className="mx-auto max-w-3xl lg:max-w-4xl px-2 md:px-4">
              {messages.map((message, i) => {
                const isLast = i === messages.length - 1;
                const isStreamingMsg = isLoading && isLast && message.role === "assistant";
                const isLatestUser = message.id === lastUserId;
                return (
                  <div
                    key={message.id}
                    data-msg-id={message.id}
                    data-role={message.role}
                    ref={isLatestUser ? lastUserMsgRef : undefined}
                  >
                    <ChatMessage
                      message={message as never}
                      chatId={chatId}
                      isAdmin={isAdmin}
                      isStreaming={isStreamingMsg}
                      onRegenerate={i === lastAssistantIndex && !readOnly ? handleRegenerate : undefined}
                      onEdit={!readOnly ? handleEdit : undefined}
                      onSwitchBranch={switchBranch}
                      onFork={handleFork}
                      actionsDisabled={isLoading}
                      model={model}
                      onModelChange={readOnly ? undefined : setModel}
                      onSend={readOnly ? undefined : handleManageSend}
                    />
                  </div>
                );
              })}
              {/* One persistent "working…" indicator, rendered in a single place
                  so it never remounts (and flickers) as the turn progresses. It
                  shows only while nothing has streamed yet — before the assistant
                  message exists, or while it's still empty. Once the first part
                  arrives, the rail's own running tail node takes over. */}
              {isLoading && (() => {
                const last = messages[messages.length - 1] as { role: string; parts?: unknown[] } | undefined;
                const showStatus = !!last && (last.role === "user" || (last.role === "assistant" && (last.parts?.length ?? 0) === 0));
                return showStatus ? (
                  <div className="px-4 py-4 md:px-6">
                    <TaskStatus startedAt={taskInfo.startedAt} currentTool={taskInfo.currentTool} retrying={taskInfo.retrying} />
                  </div>
                ) : null;
              })()}
              {/* End of real content (used to detect/scroll to the latest), then
                  the spacer that lets the latest turn rise to the top. */}
              <div ref={contentEndRef} />
              <div ref={spacerRef} aria-hidden className="shrink-0" />
            </div>
          </div>

          {/* Floating header — fades to transparent so messages scroll up
              behind it. pointer-events-none lets scroll-over pass through;
              only the controls themselves are interactive. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-background via-background to-transparent px-4 pb-8 pt-3 md:px-6">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="pointer-events-auto size-9 shrink-0 rounded-full border bg-card shadow-sm md:hidden" />
              <div className="pointer-events-auto inline-flex rounded-full border bg-card px-1 shadow-sm">
                <ModelPicker variant="pill" value={model} onChange={setModel} onResolved={handleModelResolved} />
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={`h-8 w-8 transition-all duration-200 ${
                filesOpen ? "pointer-events-none scale-90 opacity-0" : "pointer-events-auto opacity-100"
              }`}
              onClick={() => setFilesOpen(true)}
              title={t("panel.workspaceFiles")}
              aria-hidden={filesOpen}
              tabIndex={filesOpen ? -1 : 0}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>

          <ChatNav
            items={navItems}
            activeId={activeUserId}
            onJump={scrollToMessage}
            label={t("panel.navigation")}
          />

          {/* pointer-events-none lets the transparent gradient strip above the
              composer pass clicks through to the message footers behind it —
              otherwise this block's empty top band silently swallowed taps on
              the (i)/copy/regenerate row of whatever message rested under it
              (it worked in some chats and not others purely by scroll position).
              Mirrors the header above; only the real controls re-enable events. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-6 transition-transform duration-200 ease-out"
            // Lift the composer above the on-screen keyboard (iOS; ~0 elsewhere).
            style={{ transform: "translateY(calc(-1 * var(--kb, 0px)))" }}
          >
            <div
              className={`pointer-events-none mb-2 flex justify-center transition-all duration-200 ${
                showScrollDown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
              }`}
            >
              <Button
                variant="outline"
                size="icon"
                tabIndex={showScrollDown ? 0 : -1}
                aria-hidden={!showScrollDown}
                className={`h-9 w-9 rounded-full shadow-md transition-transform hover:scale-105 ${
                  showScrollDown ? "pointer-events-auto" : "pointer-events-none"
                }`}
                onClick={scrollToLatest}
                aria-label={t("panel.scrollDown")}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </div>
            {/* The composer, queue and error banner are the genuinely
                interactive part of this otherwise click-through block. Its
                height (measured via composerRef) drives the scroll inset. */}
            <div ref={composerRef} className="pointer-events-auto">
              {error && !lastFailed && (
                <div className="mx-auto max-w-3xl lg:max-w-4xl px-4 md:px-6 pb-2">
                  <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={reload}
                      aria-label={t("panel.retry")}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
              {queuedEl}
              {inputEl}
            </div>
          </div>
        </div>
      )}
      </div>
      <WorkspacePanel
        chatId={chatId}
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        running={isLoading}
        revision={toolRevision}
        folderSync={folderSync}
      />
    </div>
    </PreviewProvider>
  );
}
