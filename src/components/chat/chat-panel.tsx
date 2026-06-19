"use client";

import { useRef, useEffect, useLayoutEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

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

import { AlertCircle, ArrowDown, FolderOpen, RefreshCw, Sparkles } from "lucide-react";
import { ChatMessage } from "@/components/chat/message";
import { TaskStatus } from "@/components/chat/task-status";
import { ChatInput, type AttachedFile } from "@/components/chat/chat-input";
import { ModelPicker } from "@/components/chat/model-picker";
import { WorkspacePanel, type ProgressStep } from "@/components/chat/workspace-panel";
import { FileTypeSuggestions } from "@/components/chat/file-type-suggestions";
import { RecentChats } from "@/components/chat/recent-chats";
import { Button } from "@/components/ui/button";
import { useBackgroundChat } from "@/hooks/use-background-chat";
import { ChatNav } from "@/components/chat/chat-nav";
import { haptic } from "@/lib/haptics";

interface ChatPanelProps {
  chatId: string;
  defaultModel: string;
  projectId?: string;
  isAdmin?: boolean;
}

export function ChatPanel({ chatId, defaultModel, projectId, isAdmin }: ChatPanelProps) {
  const t = useTranslations("chat");
  const [model, setModel] = useState(defaultModel);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The latest user message ("the question"), the end of real content (before
  // the spacer), and the spacer itself — together they let us pin a turn to the
  // top the way ChatGPT/Claude do.
  const lastUserMsgRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // First paint of a chat snaps into place instantly; later sends animate. The
  // page mounts ChatPanel with key={chatId}, so this resets per chat for free.
  const seenFirstTurn = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  // The user turn currently at the top of the view — highlighted in the nav.
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  const { messages, isLoading, error, sendMessage, regenerate, editMessage, stop, reload, taskInfo } = useBackgroundChat({
    chatId,
    projectId,
  });

  // The latest assistant reply is the only one that can be regenerated; editing
  // is offered on any user message while nothing is streaming.
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  })();

  // The message that starts the latest turn. Changing this (a new send, or
  // opening a chat) is what triggers the pin-to-top animation.
  const lastUserId = messages.findLast((m) => m.role === "user")?.id;

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
    const cRect = el.getBoundingClientRect();
    const eRect = end.getBoundingClientRect();
    el.scrollTo({ top: el.scrollTop + (eRect.bottom - cRect.bottom) + 120, behavior: "smooth" });
  };

  // Bring any message (by id) to rest just below the header — powers the nav.
  const scrollToMessage = (id: string) => {
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!el || !target) return;
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
    spacer.style.height = `${Math.max(0, el.clientHeight - contentBelowUser - TOP_INSET)}px`;
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
    updateScrollDown();
    updateActiveTurn();
  }, [lastUserId]);

  // Keep the spacer correct on viewport changes; refresh the button as the
  // reply streams in (content grows, but we deliberately don't scroll).
  useEffect(() => {
    const onResize = () => { resizeSpacer(); updateScrollDown(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
    if (wasLoading.current && !isLoading) haptic("success");
    wasLoading.current = isLoading;
  }, [isLoading]);

  const [input, setInput] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);

  const handleSubmit = async () => {
    const text = input.trim();
    const attachedFiles = files.map((af) => af.file);
    if (!text && attachedFiles.length === 0) return;
    haptic("tap"); // light confirmation that the message left

    // Save state for rollback on error
    const savedInput = input;
    const savedFiles = files;
    setInput("");
    setFiles([]);
    try {
      await sendMessage(text, model, attachedFiles.length > 0 ? attachedFiles : undefined);
    } catch (e) {
      // Restore input so user doesn't lose their text
      setInput(savedInput);
      setFiles(savedFiles);
      toast.error(e instanceof Error ? e.message : t("panel.sendFailed"));
    }
  };

  const isEmpty = messages.length === 0;
  const [filesOpen, setFilesOpen] = useState(false);

  // Progress steps for the panel = the latest assistant message's tool parts.
  const lastAssistant = messages.findLast((m) => m.role === "assistant");
  const steps: ProgressStep[] = (lastAssistant?.parts ?? [])
    .filter((p): p is { type: "dynamic-tool"; toolCallId: string; toolName: string; state: string; input?: unknown } => p.type === "dynamic-tool")
    .map((p) => ({ toolName: p.toolName, state: p.state, input: p.input }));

  // A failed assistant message renders its own ErrorNotice — don't also show
  // the bottom banner for the same failure (the banner stays for load errors).
  const lastMsg = messages[messages.length - 1];
  const lastFailed = (lastMsg?.metadata as { taskStatus?: string } | undefined)?.taskStatus === "failed";

  const inputEl = (
    <ChatInput
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      onStop={stop}
      isLoading={isLoading}
      files={files}
      onFilesChange={setFiles}
    />
  );

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
      {isEmpty ? (
        <div className="relative flex flex-1 flex-col items-center justify-center py-10">
          <div className="w-full">
            <div className="mb-8 flex items-center justify-center gap-3 px-6">
              <Sparkles className="h-6 w-6 shrink-0 text-primary md:h-7 md:w-7" />
              <h1 className="font-display text-balance text-center text-3xl font-medium tracking-tight text-foreground md:text-[2.75rem] md:leading-[1.1]">
                {t("panel.greeting")}
              </h1>
            </div>

            {inputEl}

            <div className="mx-auto max-w-3xl px-4 md:px-6 lg:max-w-4xl">
              <div className="-mt-3 flex justify-center">
                <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
                  <ModelPicker variant="pill" value={model} onChange={setModel} />
                </div>
              </div>
              {!input && (
                <div className="mt-8 space-y-6">
                  <RecentChats />
                  <FileTypeSuggestions onPick={setInput} />
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {/* Scroll area fills the whole panel; the header and input float over
              it as gradients, so messages slide behind a soft fade at both ends. */}
          <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto pb-40 pt-16">
            <div className="mx-auto max-w-3xl lg:max-w-4xl px-2 md:px-4">
              {messages.map((message, i) => {
                const isLast = i === messages.length - 1;
                const isStreamingMsg = isLoading && isLast && message.role === "assistant";
                const isLatestUser = message.id === lastUserId;
                const canRegenerate = !isLoading && i === lastAssistantIndex;
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
                      onRegenerate={canRegenerate ? regenerate : undefined}
                      onEdit={!isLoading ? editMessage : undefined}
                      statusSlot={isStreamingMsg ? (
                        <TaskStatus
                          startedAt={taskInfo.startedAt}
                          currentTool={taskInfo.currentTool}
                        />
                      ) : undefined}
                    />
                  </div>
                );
              })}
              {isLoading && messages.length > 0 && messages[messages.length - 1].role === "user" && (
                <div className="px-4 py-3">
                  <TaskStatus
                    startedAt={taskInfo.startedAt}
                    currentTool={taskInfo.currentTool}
                  />
                </div>
              )}
              {/* End of real content (used to detect/scroll to the latest), then
                  the spacer that lets the latest turn rise to the top. */}
              <div ref={contentEndRef} />
              <div ref={spacerRef} aria-hidden className="shrink-0" />
            </div>
          </div>

          {/* Floating header — fades to transparent so messages scroll up
              behind it. pointer-events-none lets scroll-over pass through;
              only the controls themselves are interactive. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-background via-background to-transparent px-6 pb-8 pt-3">
            <div className="pointer-events-auto inline-flex rounded-full border bg-card px-1 shadow-sm">
              <ModelPicker variant="pill" value={model} onChange={setModel} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="pointer-events-auto h-8 w-8"
              onClick={() => setFilesOpen(!filesOpen)}
              title={t("panel.workspaceFiles")}
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

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-6">
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
            {inputEl}
          </div>
        </div>
      )}
      </div>
      <WorkspacePanel
        chatId={chatId}
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        steps={steps}
        running={isLoading}
        attachments={files}
      />
    </div>
  );
}
