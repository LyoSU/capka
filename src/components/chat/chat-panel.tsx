"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { nanoid } from "nanoid";

/** Plain text of a message — the user turns feed the chat navigator. */
function msgText(m: { parts?: { type: string; text?: string }[] }): string {
  return (m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

import { AlertCircle, FolderOpen, RefreshCw, Send, Square } from "lucide-react";
import { ChatMessage, QueuedBubble, QueuedCaption } from "@/components/chat/message";
import { TaskStatus } from "@/components/chat/task-status";
import { ChatInput } from "@/components/chat/chat-input";
import { useFolderSync } from "@/components/chat/use-folder-sync";
import { deriveContextFill } from "@/lib/chat/context/fill";
import { useAttachments, DRAFT_FILES_PREFIX } from "@/components/chat/use-attachments";
import { useChatDraft } from "@/components/chat/use-chat-draft";
import { useChatQueue, visibleQueue, type QueuedMessage } from "@/components/chat/use-chat-queue";
import { useShareImport } from "@/components/chat/use-share-import";
import { ImportCard } from "@/components/chat/import-card";
import { SourceGlyph } from "@/components/chat/import-card";
import { sourceLabel } from "@/lib/import/detect";
import type { ImportSource } from "@/lib/import/types";
import type { FileRef } from "@/lib/constants";
import { modelSupportsModality, mimeToModality, type Modality } from "@/lib/providers/registry";
import { FileDropZone } from "@/components/chat/file-drop-zone";
import { ModelPicker } from "@/components/chat/model-picker";
import { ThinkingPicker } from "@/components/chat/thinking-picker";
import { DEFAULT_THINK_AMOUNT, type ThinkAmount } from "@/lib/models/thinking";
import { WorkspacePanel } from "@/components/chat/workspace-panel";
import { PreviewProvider } from "@/components/chat/file-preview";
import { FileTypeSuggestions } from "@/components/chat/file-type-suggestions";
import { RecentChats } from "@/components/chat/recent-chats";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useBackgroundChat } from "@/hooks/use-background-chat";
import { ChatNav } from "@/components/chat/chat-nav";
import { useChatScroll, ChatScrollProvider } from "@/components/chat/use-chat-scroll";
import { JumpPill } from "@/components/chat/jump-pill";
import { ClawMark } from "@/components/brand/claw-mark";
import { pickGreeting, type GreetingLocale } from "@/lib/chat/greeting";
import { haptic } from "@/lib/haptics";
import { chatTarget } from "@/lib/workspace-target";

interface ChatPanelProps {
  chatId: string;
  defaultModel: string;
  /** Thinking depth saved on this chat (server-resolved, "balanced" when unset). */
  initialThinkAmount?: ThinkAmount;
  projectId?: string;
  /** The owning project's name (when the chat belongs to one) — drives the calm
   *  read-only breadcrumb linking back to the project hub. */
  projectName?: string;
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
  /** Experimental: offer to import a pasted Claude/ChatGPT share link. Off unless
   *  the operator sets CAPKA_SHARE_IMPORT; resolved server-side and threaded here
   *  so the client never reads env. */
  shareImportEnabled?: boolean;
}

export function ChatPanel({ chatId, defaultModel, initialThinkAmount, projectId, projectName, isAdmin, readOnly, initialHasHistory, recentChats, userName, shareImportEnabled }: ChatPanelProps) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const [model, setModel] = useState(defaultModel);

  // How hard the model should think in this chat. Persisted immediately (not only
  // on the next send) so the choice survives a reload of a chat the user hasn't
  // written to yet; a chat with no row yet has nothing to PATCH, and the send
  // carries the value along to create the row with it.
  const [thinkAmount, setThinkAmount] = useState<ThinkAmount>(initialThinkAmount ?? DEFAULT_THINK_AMOUNT);
  const thinkSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleThinkAmount = useCallback(
    (next: ThinkAmount) => {
      setThinkAmount(next); // local state stays instant — the slider must not lag
      // Dragging across the track fires one change per stop, so only the value the
      // user settles on is written. Trailing-only: nothing here is time-critical,
      // and a send would carry the value along regardless.
      if (thinkSaveRef.current) clearTimeout(thinkSaveRef.current);
      thinkSaveRef.current = setTimeout(() => {
        void fetch(`/api/chats/${chatId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thinkAmount: next }),
        }).catch(() => {
          /* the next send carries it anyway — don't nag over a failed preference write */
        });
      }, 350);
    },
    [chatId],
  );

  // Whether the chat's selected model is still serveable. The model picker
  // resolves this against the live model list (provider disconnected, or the
  // model removed from the catalog → not available). Default available:true so
  // we never block before the list settles. When it settles unavailable, the
  // composer is replaced with a "pick another model" notice — sending to a dead
  // model just produces a failed turn, so we stop it at the source.
  // The picker also hands back what the resolved model can take natively
  // (provider + per-model input modalities) — the same signal the runner uses
  // server-side — so we can warn, at attach time, that a staged file won't be
  // seen. Null modalities means "unknown", which falls back to the provider's
  // static caps inside `acceptsNativeFile`.
  const [modelStatus, setModelStatus] = useState<{
    settled: boolean;
    available: boolean;
    provider?: string;
    inputModalities?: Modality[] | null;
    reasoning?: boolean | null;
    efforts?: string[] | null;
  }>({ settled: false, available: true });
  const handleModelResolved = useCallback(
    (s: {
      settled: boolean;
      available: boolean;
      provider?: string;
      inputModalities?: Modality[] | null;
      reasoning?: boolean | null;
      efforts?: string[] | null;
    }) => setModelStatus(s),
    [],
  );

  // The new-chat greeting varies by local time and weaves in the user's name,
  // so it's random + timezone-dependent — compute it on the client after mount
  // to avoid an SSR hydration mismatch (the static fallback shows until then).
  // Keyed on chatId so each fresh chat is re-picked and feels freshly addressed.
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => {
    setGreeting(pickGreeting({ name: userName, locale: locale as GreetingLocale }));
  }, [chatId, userName, locale]);
  const router = useRouter();
  const { messages, isLoading, error, historyLoaded, sendMessage, regenerate, editMessage, switchBranch, forkChat, stop, ensureChat, reload, awaitingInput, taskInfo } = useBackgroundChat({
    chatId,
    projectId,
  });

  // Messages typed while a reply was streaming wait here and are dispatched one
  // by one as the chat frees up — held client-side so they can be removed before
  // they're sent, and drawn in the transcript as ghost bubbles where they will
  // land. Persisted per-chat to localStorage so the queue survives the
  // `key={chatId}` remount on a chat switch (the in-memory version was dropped
  // on the floor). Read this high up because the greeting depends on it.
  const { queued, setQueued } = useChatQueue(chatId);

  // Show the new-chat greeting ONLY for a genuinely fresh chat. `messages` start
  // empty until the hook's history fetch resolves, so `messages.length === 0`
  // alone can't tell a new chat from an existing one mid-load — that conflation
  // is what flashed the greeting on direct navigation. `initialHasHistory` is the
  // server's authoritative answer (chat.activeLeafId != null), so an existing
  // chat renders the stream shell from first paint; the `messages.length` guard
  // keeps the greeting from lingering after the first send on a truly new chat.
  // A non-empty queue also ends it: the greeting has no transcript, so a ghost
  // bubble would have nowhere to render and the message would look swallowed.
  const showGreeting = !initialHasHistory && messages.length === 0 && queued.length === 0;

  // The message that starts the latest turn. A change here means a new turn
  // exists — the scroll engine decides what that means (our send pins it; a turn
  // that merely appeared becomes a notice).
  const lastUserId = messages.findLast((m) => m.role === "user")?.id;

  // Everything about scrolling this transcript — the pin, following the tail,
  // holding the reader's place across the ~46 things that change its height, the
  // reading-line anchor, the jump pill and the nav's active turn.
  const scroll = useChatScroll({
    turnKey: lastUserId,
    isStreaming: isLoading,
    messageCount: messages.length,
    enabled: !showGreeting,
  });
  // Stable for the panel's lifetime, unlike `scroll` itself — so callbacks handed to
  // `memo(ChatMessage)` can close over these without a ref to keep them from
  // changing identity on every keystroke.
  const scrollActions = scroll.actions;
  // Composer attachments upload eagerly on attach (so send is instant and a
  // retry never re-uploads) and persist their refs per chat — they survive a
  // reload just like the text draft.
  const attachments = useAttachments({ chatId, ensureChat, persistKey: DRAFT_FILES_PREFIX + chatId });

  // Media modalities among the staged attachments the current model can't read
  // natively — mirrors the server's `findBlindModalities`, but computed here so
  // the composer can warn before sending. Plain documents have no modality and
  // never warn (the sandbox handles them). Empty until the picker resolves.
  const blindModalities = useMemo(() => {
    const blind: Modality[] = [];
    for (const af of attachments.files) {
      const mod = mimeToModality(af.type);
      if (!mod || blind.includes(mod)) continue;
      if (modelSupportsModality(mod, modelStatus.provider ?? "", modelStatus.inputModalities ?? null)) continue;
      blind.push(mod);
    }
    return blind;
  }, [attachments.files, modelStatus.provider, modelStatus.inputModalities]);

  // PC folders (File System Access): pushed before a message, pulled after the
  // turn. A no-op when the chat has no connected folders, so it costs nothing on
  // the common path. The target is memoized so the sync effects don't re-run on
  // every render.
  const folderTarget = useMemo(() => chatTarget(chatId), [chatId]);
  const folderSync = useFolderSync({ target: folderTarget, ensureChat });

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
  // Surface edit/regenerate failures (esp. a network reject, now localized in
  // the hook) as a toast — without a catch these rejected silently, so a failed
  // edit looked like it just vanished.
  // An edit rewrites the question, so it produces a new turn key and claims the
  // pin exactly like a send. A regenerate does NOT — the question is unchanged
  // and stays in place — so it re-seats the turn it already has, with nothing to
  // wait for. Both are the reader asking for a fresh answer, and both should put
  // the question they asked back on the reading line.
  const handleEdit = useCallback(
    (id: string, text: string, refs: FileRef[]) => {
      scrollActions.armForSend();
      // `refs` is what the editor settled on, not what the message used to carry:
      // an edit may have detached a file or attached a new one, and the re-run has
      // to feed the model the current set.
      return editMessage(id, text, model, refs).catch((e) => toast.error(e instanceof Error ? e.message : t("panel.sendFailed")));
    },
    [editMessage, model, t, scrollActions],
  );
  const handleRegenerate = useCallback(
    () => {
      scrollActions.pinLatest();
      return regenerate(model).catch((e) => toast.error(e instanceof Error ? e.message : t("panel.sendFailed")));
    },
    [regenerate, model, t, scrollActions],
  );

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

  // Provenance: an imported chat marks every row `import:<source>`. Read it off
  // the root message so the transcript can show a single quiet "Imported from …"
  // pill at the top (not per message).
  const importedFrom = (() => {
    const p = (messages[0]?.metadata as { platform?: string } | undefined)?.platform;
    return p?.startsWith("import:") ? (p.slice("import:".length) as ImportSource) : null;
  })();

  // Context-window fill for the composer meter (hidden below 50%, and hidden
  // right after a compaction until the next turn re-measures).
  const contextUsage = deriveContextFill(messages);

  // One nav entry per user turn — the minimap down the right edge.
  const navItems = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ id: m.id, text: msgText(m as { parts?: { type: string; text?: string }[] }) }));

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

  // A starter on the greeting screen writes a scaffold into the composer. Filling
  // it collapses the whole starters block (see the grid-rows transition below),
  // which unmounts the button that was just clicked — so the send of the text has
  // to be paired with handing the composer the focus, or a keyboard user is
  // dropped to `<body>` with nothing to tab back to and a mouse user has to click
  // into a field they never left.
  const [starterFocus, setStarterFocus] = useState(0);
  const fillFromStarter = useCallback(
    (text: string) => {
      setInput(text);
      setStarterFocus((n) => n + 1);
    },
    [setInput],
  );

  // Pasting a public Claude/ChatGPT share link into the composer offers to import
  // that conversation as a fresh chat and continue it here. Detection is free
  // (pure, no tokens); the render+parse only runs when the user clicks Import.
  const shareImport = useShareImport({
    text: input,
    model,
    onImported: (id) => {
      clearDraft();
      router.push(`/chat/${id}`);
    },
  });
  const importCardEl = shareImportEnabled && shareImport.detected ? (
    <ImportCard
      detected={shareImport.detected}
      state={shareImport.state}
      onImport={shareImport.startPreview}
      onConfirm={shareImport.confirmImport}
      onDismiss={shareImport.dismiss}
      onRetry={shareImport.retry}
    />
  ) : null;

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
      // block the send on it — a sync hiccup surfaces in the attach menu, not a
      // failed turn.
      await folderSync.pushAll().catch(() => {});
      // Claim the pin for the turn this send is about to create — here rather than
      // in the submit handler, so the queue drain and the manage cards' own sends
      // get the same treatment. Claimed as late as possible and consumed by the
      // bubble `sendMessage` adds optimistically, which keeps the window in which
      // an unrelated Telegram turn could collect it down to this one call.
      scrollActions.armForSend();
      await sendMessage(text, model, refs.length > 0 ? refs : undefined, id, thinkAmount);
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

  // Stable sender for in-transcript buttons that speak as the user — a manage
  // card's confirm/undo, and the "continue" on a part-way failure. Kept referentially
  // stable (via a ref to the latest `send`) so it doesn't bust ChatMessage's memo
  // and re-render the whole transcript on every keystroke.
  const sendRef = useRef(send);
  sendRef.current = send;
  // Returns `send`'s own verdict rather than swallowing it in `void`: the Continue
  // button disables itself on click to stop a double-send, and without the outcome it
  // could never re-enable — a failed send left it dead until a reload.
  const handleSendAsUser = useCallback((text: string) => sendRef.current(text, []), []);

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
    // `!historyLoaded`: a chat opened moments ago may not have its history yet,
    // so sending now would carry no conversation context to the model. Queue it
    // (persisted) and let the drain effect fire once history resolves.
    if (!historyLoaded || isLoading || queued.length > 0 || dispatchingRef.current || sendingRef.current) {
      // nanoid (not crypto.randomUUID, which is undefined on non-secure origins)
      // — and this id rides through the drain into the POST as the message id, so
      // a double-drain (same chat in two tabs) collapses server-side.
      setQueued((q) => [...q, { id: nanoid(), text, refs }]);
      // The ghost lands at the very end of the transcript, which during a turn is
      // below the pinned reading line and therefore off screen — the user just
      // pressed Enter and has to see their message arrive. Mid-stream this hands
      // the engine the `tail` role (follow the end), not a reader lock.
      scrollActions.jumpToBottom();
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

  // The item the drain is currently sending. It has already been taken out of
  // localStorage (see below), so without holding it here its ghost would blink
  // out of the transcript and back in — `visibleQueue` keeps it drawn until the
  // real bubble carrying the same id exists.
  const [sending, setSending] = useState<QueuedMessage | null>(null);

  // What the transcript already holds. A ghost is dropped the instant its real
  // bubble appears: the drain reuses the queued id as the message id, and
  // sendMessage inserts that bubble synchronously — before the POST — so keying
  // off ids (not off `send()` resolving) is what keeps the message from being
  // drawn twice for the length of the round-trip.
  const messageIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);

  // Ids this panel has drawn as a ghost, so the real bubble can skip its
  // entrance animation and solidify in place instead of blinking. Bounded by how
  // many messages the user queued in this chat — the same order as the transcript
  // itself — and dropped entirely on the `key={chatId}` remount.
  const ghostedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const q of queued) ghostedRef.current.add(q.id);
    if (sending) ghostedRef.current.add(sending.id);
  }, [queued, sending]);
  const ghostGroupRef = useRef<HTMLDivElement>(null);

  // The queued message whose editor is open, if any. It parks the drain: the
  // reply can finish at any moment, and without this the turn would end mid-edit
  // and post whatever half-written text happened to be stored. The ref is what
  // the already-running drain loop reads — its closure was captured before the
  // editor opened, so the state alone would not reach it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = editingId;

  // Drain the queue when the chat frees up: send each queued message as its own
  // message (separate bubbles, just as the user typed them) — the server folds
  // the whole burst into a single reply. Sent sequentially so they chain in
  // order; the ref guards the async gap before isLoading flips.
  useEffect(() => {
    if (!historyLoaded || isLoading || dispatchingRef.current || queued.length === 0) return;
    // An open editor parks the whole queue, not just the message being edited:
    // the user is mid-sentence about what they want to say next, and firing the
    // messages around it would settle that question for them.
    if (editingId) return;
    const batch = queued;
    dispatchingRef.current = true;
    void (async () => {
      for (const item of batch) {
        // Re-checked every iteration, not just at the top: a burst takes a
        // round-trip per message, which is plenty of time to click the pencil on
        // one still waiting. Stop at this boundary — the rest stay queued and
        // re-drain once the editor closes.
        if (editingIdRef.current) break;
        // Dequeue this one as we start it — NOT the whole batch up-front. A reload
        // mid-drain then keeps the not-yet-started items in localStorage (the
        // whole point of persisting the queue), and the stable id keeps the
        // in-flight one idempotent if it raced through to the server.
        setQueued((q) => q.filter((m) => m.id !== item.id));
        setSending(item);
        const ok = await send(item.text, item.refs, item.id);
        // A hard failure put the text back in the composer; stop the burst rather
        // than hammering a failing server — the rest stay queued and re-drain when
        // the chat is free, one attempt each (no retry loop: each is dequeued).
        if (!ok) break;
      }
    })().finally(() => { dispatchingRef.current = false; setSending(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, queued, historyLoaded, editingId]);

  const [filesOpen, setFilesOpen] = useState(false);

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

  // Rides in the same pill shell as the model picker, and renders itself away
  // when the resolved model has no reasoning levels worth offering. Hidden on a
  // read-only (Telegram) chat, where nothing is sendable from here anyway.
  // The model + thinking pair, built once and placed differently per breakpoint:
  // inside the composer on phones (where these settings sit next to the message
  // they govern, and where nothing else fits), in the header / under the greeting on
  // desktop. `controlsEl` is the phone copy; `md:hidden` / `hidden md:*` on the two
  // hosts decide which one is live, so only one is ever interactive.
  const thinkingEl = readOnly ? null : (
    <ThinkingPicker
      value={thinkAmount}
      onChange={handleThinkAmount}
      provider={modelStatus.provider}
      reasoning={modelStatus.reasoning}
      efforts={modelStatus.efforts}
      disabled={modelGone}
    />
  );

  // The phone control — same corner it always lived in, just made to fit.
  //
  // ONE trigger, not two. Model and thinking depth are a single decision ("how the
  // assistant answers"), and the header could not hold two labelled settings beside
  // the sidebar handle and the files button: the model name alone wanted 128px, so
  // the row overran the viewport. `compact` (brand icon + chevron) is ~52px, which
  // leaves the row roomy, and the depth slider rides at the foot of the overlay this
  // trigger already opens — rendered `inline`, so there's no popover stacked on top
  // of a full-screen sheet.
  const compactControlsEl = readOnly ? null : (
    <div className="pointer-events-auto inline-flex shrink-0 items-center rounded-full bg-card px-0.5 shadow-raised md:hidden">
      <ModelPicker
        variant="pill"
        compact
        value={model}
        onChange={setModel}
        onResolved={handleModelResolved}
        extra={
          <ThinkingPicker
            inline
            value={thinkAmount}
            onChange={handleThinkAmount}
            provider={modelStatus.provider}
            reasoning={modelStatus.reasoning}
            efforts={modelStatus.efforts}
            disabled={modelGone}
          />
        }
      />
    </div>
  );

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
      blindModalities={blindModalities}
      contextUsage={contextUsage}
      folders={folderSync}
      focusSignal={starterFocus}
    />
  );

  // Pending messages, drawn at the tail of the transcript exactly where they
  // will land — real-looking but held translucent until they're actually sent.
  const ghosts = visibleQueue({ sending, queued, messageIds });
  const ghostsEl = ghosts.length > 0 ? (
    // `tabIndex={-1}`: removing a ghost unmounts the × that had focus, which
    // would drop the caret to <body> and lose a keyboard user's place. The group
    // takes the focus instead, next to whatever is left of the queue.
    // `role="group"` because an aria-label on a bare div has no role to attach to
    // and is dropped — the label is the whole point of focusing here.
    <div ref={ghostGroupRef} tabIndex={-1} role="group" aria-label={t("panel.queuedPending")} className="focus:outline-none">
      {ghosts.map((q) => {
        // No way back once it's on the wire — the drain has already handed this
        // one to the server, so it gets neither pencil nor ×.
        const onWire = q.id === sending?.id;
        return (
          <QueuedBubble
            key={q.id}
            text={q.text}
            refs={q.refs}
            chatId={chatId}
            editing={editingId === q.id}
            onEditingChange={onWire ? undefined : (open) => setEditingId(open ? q.id : null)}
            onEdit={onWire ? undefined : (next, nextRefs) => {
              // Both halves, not just the text — the editor can detach a file or
              // attach a new one, and dropping `refs` here would silently send
              // the message with the files the user just changed.
              // The id is deliberately kept: it's what makes the send idempotent
              // and what ties this ghost to the bubble it becomes.
              setQueued((qq) => qq.map((x) => (x.id === q.id ? { ...x, text: next, refs: nextRefs } : x)));
            }}
            onCancel={onWire ? undefined : () => {
              setQueued((qq) => qq.filter((x) => x.id !== q.id));
              if (editingId === q.id) setEditingId(null);
              ghostGroupRef.current?.focus();
            }}
          />
        );
      })}
      <QueuedCaption
        count={ghosts.length}
        held={editingId !== null}
        // Only offered against a turn that is genuinely streaming. Two holds
        // must NOT be interruptible: `awaitingInput` is a turn suspended on the
        // user's own approval or answer — cancelling it throws away the question
        // — and `!historyLoaded` means this client has no conversation to send
        // yet, so "now" would reach the model with an empty context.
        onSendNow={isLoading && !awaitingInput && historyLoaded && !readOnly ? () => { void stop(); } : undefined}
      />
    </div>
  ) : null;

  return (
    <ChatScrollProvider value={scrollActions}>
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
          <SidebarTrigger className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 size-9 rounded-full bg-card shadow-raised md:hidden" />
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
            {/* The brand claw reveals on mount — the one signature flourish — and
                the greeting floats up just behind it. No radial halo behind the
                mark: on this near-white surface the 8% wash didn't read as light,
                it read as a smudge the page had picked up, and a glow under the
                logo is the single most generic thing an AI product can wear. The
                mark holds the eye on its own. */}
            <div className="mb-8 flex flex-col items-center px-6">
              <ClawMark animated className="h-20 w-20 text-foreground md:h-24 md:w-24" />
              <h1 className="animate-claw-greet mt-6 font-display text-balance text-center text-fluid-display font-medium tracking-tight text-foreground">
                {greeting ?? t("panel.greeting")}
              </h1>
            </div>

            {importCardEl}
            <div className="animate-blur-rise [animation-delay:80ms]">{inputEl}</div>

            <div className="mx-auto max-w-3xl px-4 md:px-6 lg:max-w-4xl">
              {/* relative z-20 keeps the picker (and its absolute dropdown) in a
                  stacking context above the starters block below — otherwise the
                  later sibling paints over the open dropdown. */}
              {/* Stays on both breakpoints. The greeting gives this pill a row of its
                  own, so the labelled form fits a phone here — the crowding was only
                  ever in the chat header, where it shared a row with two other
                  controls. */}
              <div className="animate-blur-rise relative z-20 -mt-3 flex justify-center [animation-delay:140ms]">
                <div className="inline-flex min-w-0 items-center rounded-full bg-card px-1 shadow-raised">
                  <ModelPicker variant="pill" value={model} onChange={setModel} onResolved={handleModelResolved} />
                  {thinkingEl}
                </div>
              </div>
              {/* Hint + recent + starters collapse away the moment the user starts
                  typing. Animating grid-rows 1fr→0fr (not unmounting) shrinks the
                  height over 300ms, so the centered composer above glides to its
                  new center instead of snapping. `inert` drops the hidden controls
                  from tab/click order; the global reduced-motion rule flattens the
                  transition to instant. */}
              <div
                className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                  input ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                }`}
                inert={input ? true : undefined}
              >
                <div className="overflow-hidden">
                  {/* pt-6, not pt-2.5: at the tighter spacing this line sat closer
                      to the model pill than to anything else and read as a caption
                      *for the pill* — a sentence about files filed under the model
                      name. The gap is what says which block it belongs to. */}
                  <div className="animate-blur-rise pt-6 [animation-delay:200ms]">
                    <p className="text-center text-xs text-muted-foreground">{t("panel.greetingHint")}</p>
                    <div className="mt-6 space-y-6">
                      <RecentChats initial={recentChats} />
                      <FileTypeSuggestions onPick={fillFromStarter} />
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
          {/* `overflow-anchor:none` is load-bearing, not a tidy-up: Chrome and
              Firefox would otherwise ALSO compensate for height changes above the
              reader, on top of the compensation useChatScroll performs — while
              Safari, which ships scroll anchoring in no stable release, would not.
              Turning the native one off is what makes iOS and Android behave the
              same. The reading line is one CSS token: it sets this padding, the
              matching `scroll-padding` for browser-driven scrolls, and — since the
              engine reads the padding back off the element — the line the whole
              state machine measures against. */}
          <div
            ref={scroll.scrollRef}
            className="flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
            role="log"
            aria-label={t("panel.conversation")}
            // A series of streamed deltas is not a series of announcements. `role="log"`
            // carries an implicit polite live region, so without this a screen reader
            // would read a reply out a token at a time; `aria-busy` lets the whole turn
            // land as one unit. Verified behaviour differs between readers, so this is
            // the conservative choice, not a guess at a nicety.
            aria-busy={isLoading || undefined}
            style={{
              // Bottom room is the composer's live height plus the footer gradient's
              // own air, both measured — so the tail of a reply always clears the
              // overlaid composer, even after attachments grow it.
              paddingTop: "var(--reading-line)",
              paddingBottom: `calc(${scroll.bottomReserve}px + var(--kb, 0px))`,
              // The same optimal region, declared for the scrolls the BROWSER drives:
              // focusing a control with the keyboard, find-in-page, `scrollIntoView`.
              // Without it those land their target under the gradient header or behind
              // the composer, which our own engine would then have to undo.
              scrollPaddingBlockStart: "var(--reading-line)",
              scrollPaddingBlockEnd: `calc(${scroll.bottomReserve}px + var(--kb, 0px))`,
            }}
          >
            <div className="mx-auto max-w-3xl lg:max-w-4xl px-2 md:px-4">
              {importedFrom && (
                <div className="flex justify-center pb-2 pt-1">
                  <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
                    <SourceGlyph source={importedFrom} size={12} />
                    {t("panel.importedFrom", { service: sourceLabel(importedFrom) })}
                  </span>
                </div>
              )}
              {messages.map((message, i) => {
                const isLast = i === messages.length - 1;
                const isStreamingMsg = isLoading && isLast && message.role === "assistant";
                const isLatestUser = message.id === lastUserId;
                return (
                  <div
                    key={message.id}
                    data-msg-id={message.id}
                    data-role={message.role}
                    // Anchor candidate. Marked here as the fallback granularity;
                    // assistant messages also mark their individual blocks, and the
                    // engine prefers the deepest marked block near the reading line
                    // — a change inside a screens-tall message can leave the
                    // message's own box still while moving the text being read.
                    data-scroll-anchor="msg"
                    data-anchor-id={message.id}
                    ref={isLatestUser ? scroll.pinRef : undefined}
                  >
                    <ChatMessage
                      message={message as never}
                      chatId={chatId}
                      isAdmin={isAdmin}
                      isStreaming={isStreamingMsg}
                      // Building the container happens inside a tool call that is
                      // already spinning on the rail, so it gets a dim sub-line
                      // under that step rather than a second indicator of its own.
                      sandboxPending={isStreamingMsg && taskInfo.phase === "sandbox"}
                      onRegenerate={i === lastAssistantIndex && !readOnly ? handleRegenerate : undefined}
                      onEdit={!readOnly ? handleEdit : undefined}
                      onSwitchBranch={switchBranch}
                      onFork={handleFork}
                      actionsDisabled={isLoading}
                      onSend={readOnly ? undefined : handleSendAsUser}
                      // Same gate as regenerate: continuing is only meaningful for
                      // the newest reply, since anything later has already moved on.
                      onContinue={i === lastAssistantIndex && !readOnly ? handleSendAsUser : undefined}
                      // Already seen as a ghost — let it solidify where it stands
                      // rather than replaying an entrance from opacity 0.
                      enter={!ghostedRef.current.has(message.id)}
                    />
                  </div>
                );
              })}
              {/* One persistent "working…" indicator, rendered in a single place
                  so it never remounts (and flickers) as the turn progresses. It
                  shows only while nothing has streamed yet — before the assistant
                  message exists, or while it's still empty. Once the first part
                  arrives, the rail's own running tail node takes over.
                  EXCEPTION: a provider stall. The rail's nodes carry no "we are
                  retrying" state, so with that rule alone the retry notice had
                  nowhere to render as soon as anything had streamed — which for a
                  reasoning model is within a second, leaving the user watching
                  minutes of silence and then a bare failure. While `retrying` is
                  set the row comes back regardless, reading as the next step on
                  the rail (it mirrors a running node) and explaining the frozen
                  spinner above it. It clears itself the moment content flows. */}
              {isLoading && (() => {
                const last = messages[messages.length - 1] as { role: string; parts?: { type: string; state?: string; toolName?: string }[] } | undefined;
                // The gap this closes: a tool has returned and the model is
                // deciding what to do next. The rule above (empty reply) no
                // longer holds — there ARE parts — and the rail spins only on a
                // step whose state is still running, so with a model that emits
                // no reasoning BOTH indicators fell silent and the only sign the
                // turn was alive was the Stop button. A finished tool as the last
                // part means exactly "nothing is in flight but the turn is", so
                // the same row comes back rather than a new kind of indicator.
                const tail = last?.parts?.at(-1);
                const afterTool =
                  last?.role === "assistant" && tail?.type === "dynamic-tool" && !!tail.state?.startsWith("output-");
                const showStatus = !!taskInfo.retrying || (!!last && (last.role === "user" || (last.role === "assistant" && (last.parts?.length ?? 0) === 0) || afterTool));
                // Whether the block directly above this row is the activity rail,
                // and so whether the row should read as its next node rather than
                // as a separate indicator floating a message-gap below it. A
                // `manage` or `ask` result escapes the rail into its own prominent
                // card, and those resolve to an `output-` state like any other tool
                // — so `afterTool` alone would hang a timeline off a card. Excluded
                // by name on purpose: the real predicates are private to message.tsx
                // and a second copy here would drift out of step with them, whereas
                // this errs only toward the row keeping its old spacing.
                const continuesRail = afterTool && tail?.toolName !== "manage" && tail?.toolName !== "ask";
                return showStatus ? (
                  // The negative margin cancels the message's own bottom padding, so
                  // the row lands at the rail's rhythm (py-1 to py-1) instead of a
                  // message gap away from it. Only when it continues the rail: at the
                  // start of a turn this row sits under the USER's bubble, where the
                  // distance is correct and hugging would be wrong.
                  <div className={continuesRail ? "-mt-4 px-4 pb-4 md:px-6" : "px-4 py-4 md:px-6"}>
                    <TaskStatus startedAt={taskInfo.startedAt} currentTool={taskInfo.currentTool} retrying={taskInfo.retrying} phase={taskInfo.phase} continuesRail={continuesRail} />
                  </div>
                ) : null;
              })()}
              {/* Messages the user typed while this turn was running. They sit
                  after the running indicator because that is where they belong in
                  time — and INSIDE the content, above `contentEndRef`, so
                  "scroll to the end" lands on them rather than stopping short. */}
              {ghostsEl}
              {/* End of real content (used to detect/scroll to the latest), then
                  the spacer that lets the latest turn rise to the top. */}
              <div ref={scroll.contentEndRef} />
              <div ref={scroll.spacerRef} aria-hidden className="shrink-0" />
            </div>
          </div>

          {/* Floating header — fades to transparent so messages scroll up
              behind it. pointer-events-none lets scroll-over pass through;
              only the controls themselves are interactive. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-background via-background to-transparent px-4 pb-8 pt-3 md:px-6">
            {/* Same corner on both breakpoints — only the density differs. Desktop
                gets the labelled pill; a phone gets `compactControlsEl` above, which
                is the same two settings behind one ~52px trigger. `min-w-0` keeps the
                desktop row honest under width pressure. */}
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="pointer-events-auto size-9 shrink-0 rounded-full bg-card shadow-raised md:hidden" />
              {compactControlsEl}
              <div className="pointer-events-auto hidden min-w-0 items-center rounded-full bg-card px-1 shadow-raised md:inline-flex">
                <ModelPicker variant="pill" value={model} onChange={setModel} onResolved={handleModelResolved} />
                {thinkingEl}
              </div>
              {projectId && projectName && (
                <Hint label={projectName} side="bottom">
                  <Link
                    href={`/projects/${projectId}`}
                    className="pointer-events-auto inline-flex max-w-[40vw] items-center gap-1 truncate rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-raised transition-colors hover:text-foreground"
                  >
                    <FolderOpen className="h-3 w-3 shrink-0" />
                    <span className="truncate">{projectName}</span>
                  </Link>
                </Hint>
              )}
            </div>
            <Hint label={t("panel.workspaceFiles")}>
              <Button
                variant="ghost"
                size="icon"
                // `shrink-0`: a fixed `w-8` is still shrinkable in flex, so under
                // width pressure this button squashed before the model name gave way.
                className={`h-8 w-8 shrink-0 transition-[transform,opacity] duration-200 ${
                  filesOpen ? "pointer-events-none scale-90 opacity-0" : "pointer-events-auto opacity-100"
                }`}
                onClick={() => setFilesOpen(true)}
                aria-hidden={filesOpen}
                tabIndex={filesOpen ? -1 : 0}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </Hint>
          </div>

          <ChatNav
            items={navItems}
            activeId={scroll.activeUserId}
            onJump={scrollActions.jumpToMessage}
            label={t("panel.navigation")}
          />

          {/* pointer-events-none lets the transparent gradient strip above the
              composer pass clicks through to the message footers behind it —
              otherwise this block's empty top band silently swallowed taps on
              the (i)/copy/regenerate row of whatever message rested under it
              (it worked in some chats and not others purely by scroll position).
              Mirrors the header above; only the real controls re-enable events. */}
          {/* The jump pill lives OUTSIDE the footer's flow, floating over the
              transcript. Inside it, its ~44px row was reserved scroll room even
              while hidden — a permanent band of dead space paying for an
              affordance that is absent most of the time. */}
          <JumpPill
            show={scroll.showJump}
            tone={scroll.jumpTone}
            bottom={scroll.bottomReserve}
            onClick={scrollActions.jumpToBottom}
            newLabel={t("panel.newMessage")}
            label={t("panel.scrollDown")}
          />

          <div
            ref={scroll.footerRef}
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-6 transition-transform duration-200 ease-out"
            // Lift the composer above the on-screen keyboard (iOS; ~0 elsewhere).
            style={{ transform: "translateY(calc(-1 * var(--kb, 0px)))" }}
          >
            {/* The composer and error banner are the genuinely interactive part
                of this otherwise click-through block. */}
            <div className="pointer-events-auto">
              {error && !lastFailed && (
                <div className="mx-auto max-w-3xl lg:max-w-4xl px-4 md:px-6 pb-2">
                  <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <Hint label={t("panel.retry")}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={reload}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    </Hint>
                  </div>
                </div>
              )}
              {importCardEl}
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
    </ChatScrollProvider>
  );
}
