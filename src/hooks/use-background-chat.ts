"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { nanoid } from "nanoid";
import { type FileRef } from "@/lib/constants";
import type { TaskEvent } from "@/lib/tasks/events";
import { mergePendingMessages, pendingStillUnknown } from "@/lib/chat/optimistic";
import { classifyStreamEvent } from "@/lib/chat/stream-reconcile";

// ── Types ────────────────────────────────────────────────────

type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "dynamic-tool"; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown; approval?: { id: string; approved?: boolean; reason?: string }; askForm?: import("@/lib/ask/types").AskForm; askValue?: import("@/lib/ask/types").AskAnswer };

type Message = {
  id: string;
  role: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
};

// ── Hook ─────────────────────────────────────────────────────

export function useBackgroundChat({
  chatId,
  projectId,
}: {
  chatId: string;
  projectId?: string;
}) {
  const t = useTranslations("chat.hook");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskInfo, setTaskInfo] = useState<{ startedAt: number; currentTool: string | null; retrying: { attempt: number; max: number } | null }>({ startedAt: 0, currentTool: null, retrying: null });
  const msgRef = useRef(messages);
  msgRef.current = messages;
  // Optimistic user messages whose POST is still in flight. A task:finish for a
  // PRIOR turn can reload history before a just-queued message has committed —
  // the reloaded path wouldn't include it, so loadHistory re-appends these and
  // drops each one only once a reload actually returns its id (durably saved).
  const pendingRef = useRef<Message[]>([]);
  // Whether the SSE stream is currently connected — drives how hard the polling
  // fallback works (aggressive only when SSE is down).
  const sseHealthyRef = useRef(false);
  // Highest realtime `seq` already applied to each streaming message. SSE has no
  // replay and deltas are incremental, so a client that (re)mounts mid-stream
  // would otherwise append live deltas onto an empty/stale prefix and show a
  // truncated reply. Seeded from the DB snapshot's `streamSeq` on load; each
  // applied delta advances it. Lets us tell covered/next/gapped deltas apart and
  // reconcile from the DB when there's a gap. See classifyStreamEvent.
  const appliedSeqRef = useRef<Map<string, number>>(new Map());

  const [error, setError] = useState<string | null>(null);

  // ── Load history from DB ───────────────────────────────────
  const loadHistory = useCallback(() => {
    fetch(`/api/chat?chatId=${chatId}`)
      .then((r) => {
        if (r.status === 404) return []; // new chat — no history yet
        if (!r.ok) throw new Error(`Failed to load chat (${r.status})`);
        return r.json();
      })
      .then((history: Message[]) => {
        if (history.length > 0) {
          // The server now owns any pending message it returns — stop preserving
          // those, then keep re-appending the ones still mid-flight so a queued
          // message never blinks out between turns.
          pendingRef.current = pendingStillUnknown(history, pendingRef.current);
          setMessages(mergePendingMessages(history, pendingRef.current));
        }
        setError(null);
        // Find the running assistant reply (the snapshot we may be resuming). It's
        // normally the last message, but a just-queued user follow-up can sit
        // after it — so scan from the end rather than assuming `last`.
        const running = [...history].reverse().find(
          (m) => (m.metadata as { taskStatus?: string } | undefined)?.taskStatus === "running",
        );
        if (running) {
          setStatus("running");
          // Adopt the running turn's taskId from the message it's attached to.
          // Without this, a reconnect to a live turn shows "running" (and the
          // stop button) but leaves taskId null — so stop() was a dead no-op.
          const meta = running.metadata as { streamSeq?: number; taskId?: string } | undefined;
          if (meta?.taskId) setTaskId(meta.taskId);
          // Seed the applied-seq from the snapshot we just loaded so resumed
          // deltas reconcile against it (this IS the gap-closing step on resume).
          appliedSeqRef.current.set(running.id, meta?.streamSeq ?? 0);
        }
        // No cleanup needed for finished turns: message ids are unique per reply,
        // so a stale cursor can never gate a future stream, and task:finish
        // already drops the running one. (Avoids racing a just-set task:start
        // cursor when this load was triggered by a prior turn finishing.)
      })
      .catch((e) => {
        console.error("[chat] loadHistory failed:", e);
        setError(t("loadFailed"));
      });
  }, [chatId, t]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── Check for running task on mount (reconnection) ─────────
  useEffect(() => {
    fetch(`/api/tasks?chatId=${chatId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((task) => {
        if (task?.status === "running") {
          setTaskId(task.id);
          setStatus("running");
        }
      })
      .catch(() => {});
  }, [chatId]);

  // ── SSE listener ───────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let truncReloadTimer: ReturnType<typeof setTimeout>;
    let reconcileTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000; // exponential backoff: 1s, 2s, 4s, 8s, max 30s

    // A gap in the seq stream (we reconnected mid-stream, or a NOTIFY dropped)
    // means our delta-accumulated copy is behind — pull a fresh DB snapshot
    // rather than append onto a stale prefix. Debounced so a burst of gapped
    // deltas during the resume window collapses into one reload; loadHistory
    // re-seeds appliedSeq from the snapshot's streamSeq, after which live deltas
    // resume cleanly.
    const reconcileSoon = () => {
      clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(loadHistory, 250);
    };

    // Streaming events that mutate the reply and carry a per-message seq — gated
    // through classifyStreamEvent so a resumed stream reconciles instead of
    // truncating. task:start/reset/finish are handled explicitly, not gated.
    const GATED = new Set([
      "task:text-delta", "task:reasoning-delta",
      "task:tool-input-start", "task:tool-call", "task:tool-result", "task:tool-approval",
    ]);

    const connect = () => {
      es = new EventSource("/api/events");

      es.onopen = () => { retryDelay = 1000; sseHealthyRef.current = true; }; // reset backoff on success

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as TaskEvent;

          // Only handle events for this chat
          if ("chatId" in data && data.chatId !== chatId) return;

          // A NOTIFY payload too big for Postgres (e.g. an oversized text burst)
          // arrives as a stripped marker carrying only `_truncated: true` plus the
          // ids — its body (delta/result) is gone. Honour the contract the realtime
          // layer promises and re-read this message from the DB, which holds the
          // full part. Debounced so a burst collapses into one reload. (Big tool
          // results are already capped server-side, so this is a rare safety net.)
          if ((data as { _truncated?: boolean })._truncated) {
            clearTimeout(truncReloadTimer);
            truncReloadTimer = setTimeout(loadHistory, 250);
            return;
          }

          // Reconcile gate: for seq-stamped streaming events, decide whether this
          // delta is already covered by our snapshot (ignore), the next one
          // (apply), or past a gap (reconcile from the DB). A delta with no seq
          // (legacy publisher) always applies, so nothing else regresses.
          if (GATED.has(data.type) && "messageId" in data) {
            const mid = data.messageId as string;
            const seq = (data as { seq?: number }).seq;
            const action = classifyStreamEvent(appliedSeqRef.current.get(mid) ?? -1, seq);
            if (action === "ignore") return;
            if (action === "reconcile") { reconcileSoon(); return; }
            // action === "apply": advance the cursor, then run the handler below.
            if (typeof seq === "number") appliedSeqRef.current.set(mid, seq);
            // Content is flowing again — clear any "retrying" notice from a stall.
            setTaskInfo((prev) => (prev.retrying ? { ...prev, retrying: null } : prev));
          }

          switch (data.type) {
            case "task:start": {
              setStatus("running");
              // Track the taskId from the live event too — a turn that begins
              // while we're watching (a queued send draining, a Telegram-sourced
              // turn, another tab) would otherwise leave the stop button unable
              // to cancel anything (taskId was only set by our own POST before).
              setTaskId(data.taskId);
              setTaskInfo({ startedAt: Date.now(), currentTool: null, retrying: null });
              // Baseline the seq cursor for this reply (task:start is seq 0), so
              // the first delta (seq 1) is the next contiguous one. NEVER lower a
              // cursor we've already advanced: a redelivered/late task:start
              // (reconnect racing a snapshot load) must not reset us to 0, or
              // already-applied deltas would re-classify as `apply` and duplicate.
              {
                const prevSeq = appliedSeqRef.current.get(data.messageId);
                const baseline = data.seq ?? 0;
                appliedSeqRef.current.set(
                  data.messageId,
                  prevSeq === undefined ? baseline : Math.max(prevSeq, baseline),
                );
              }
              // Idempotent: if history already loaded this assistant row
              // (reconnect / cross-channel), don't append a duplicate.
              setMessages((prev) =>
                prev.some((m) => m.id === data.messageId)
                  ? prev
                  : [...prev, { id: data.messageId, role: "assistant", parts: [] }],
              );
              break;
            }

            case "task:reset": {
              // A runner retry threw away the partial reply — clear the streamed
              // parts so retry deltas don't append onto the abandoned attempt, and
              // move the cursor to the reset's seq.
              appliedSeqRef.current.set(data.messageId, data.seq);
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                msgs[idx] = { ...msgs[idx], parts: [] };
                return msgs;
              });
              break;
            }

            case "task:text-delta": {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = [...msg.parts];
                const lastPart = parts[parts.length - 1];
                if (lastPart?.type === "text") {
                  parts[parts.length - 1] = { type: "text", text: lastPart.text + data.delta };
                } else {
                  parts.push({ type: "text", text: data.delta });
                }
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:reasoning-delta": {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = [...msg.parts];
                const lastPart = parts[parts.length - 1];
                if (lastPart?.type === "reasoning") {
                  parts[parts.length - 1] = { type: "reasoning", text: lastPart.text + data.delta };
                } else {
                  parts.push({ type: "reasoning", text: data.delta });
                }
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:tool-input-start": {
              // The model began a tool call; args haven't arrived yet. Show the
              // step immediately as a spinner with a generic label — `tool-call`
              // refines it once the parsed args land.
              setTaskInfo((prev) => ({ ...prev, currentTool: data.toolName }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msg = prev[idx];
                // A reconnect may replay it — don't add the same step twice.
                if (msg.parts.some((p) => p.type === "dynamic-tool" && p.toolCallId === data.toolCallId)) return prev;
                const msgs = [...prev];
                msgs[idx] = {
                  ...msg,
                  parts: [...msg.parts, {
                    type: "dynamic-tool",
                    toolCallId: data.toolCallId,
                    toolName: data.toolName,
                    // AI SDK 6 state for a call whose args are still streaming in.
                    state: "input-streaming",
                  }],
                };
                return msgs;
              });
              break;
            }

            case "task:tool-call": {
              setTaskInfo((prev) => ({ ...prev, currentTool: data.toolName }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const existing = msg.parts.some((p) => p.type === "dynamic-tool" && p.toolCallId === data.toolCallId);
                msgs[idx] = {
                  ...msg,
                  // Refine the step opened by tool-input-start: fill the parsed
                  // args and mark the input complete (output still pending). If no
                  // input-start was seen (older worker / missed event), add it.
                  parts: existing
                    ? msg.parts.map((p) =>
                        p.type === "dynamic-tool" && p.toolCallId === data.toolCallId
                          ? { ...p, state: "input-available", input: data.args }
                          : p,
                      )
                    : [...msg.parts, {
                        type: "dynamic-tool",
                        toolCallId: data.toolCallId,
                        toolName: data.toolName,
                        state: "input-available",
                        input: data.args,
                      }],
                };
                return msgs;
              });
              break;
            }

            case "task:tool-result": {
              setTaskInfo((prev) => ({ ...prev, currentTool: null }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                // Trust the server's explicit failure flag — a successful tool can
                // legitimately carry an `error: null` field, which must not read
                // as a failure (otherwise it flashes red mid-stream).
                const isError = data.isError === true;
                const parts = msg.parts.map((p) =>
                  p.type === "dynamic-tool" && p.toolCallId === data.toolCallId
                    ? { ...p, state: isError ? "output-error" : "output-available", output: data.result }
                    : p,
                );
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:tool-approval": {
              // Native HITL: the SDK suspended this tool call — flip it to
              // approval-requested so the card shows Approve/Reject and the composer
              // blocks. task:finish follows (the turn finalized as awaiting_approval);
              // loadHistory then re-derives the same state from the persisted marker.
              setTaskInfo((prev) => ({ ...prev, currentTool: null }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = msg.parts.map((p) =>
                  p.type === "dynamic-tool" && p.toolCallId === data.toolCallId
                    ? { ...p, state: "approval-requested", approval: { id: data.approvalId } }
                    : p,
                );
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:ask": {
              // The runner suspended a no-execute `ask` call — flip the live tool
              // part to input-available and attach the form so the question card
              // renders and the composer blocks. task:finish follows (finalized as
              // awaiting_answer); loadHistory then re-derives the same state from the
              // persisted `answer` marker. (An `elicit:` toolCallId has no persisted
              // part yet — handled in the MCP elicitation phase.)
              setTaskInfo((prev) => ({ ...prev, currentTool: null }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const found = msg.parts.some((p) => p.type === "dynamic-tool" && p.toolCallId === data.toolCallId);
                const parts = found
                  ? msg.parts.map((p) =>
                      p.type === "dynamic-tool" && p.toolCallId === data.toolCallId
                        ? { ...p, state: "input-available", askForm: data.form }
                        : p,
                    )
                  // An MCP elicitation (`elicit:` id) has no persisted tool-call part —
                  // append a transient ask part so the same card renders mid-turn. It's
                  // not persisted (elicitation is non-durable), so a reload drops it.
                  : [...msg.parts, { type: "dynamic-tool" as const, toolCallId: data.toolCallId, toolName: "ask", state: "input-available", askForm: data.form }];
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:finish": {
              setStatus("idle");
              setTaskId(null);
              setTaskInfo({ startedAt: 0, currentTool: null, retrying: null });
              // Stop tracking this reply's seq — the turn is done; loadHistory
              // below reloads the final, authoritative content.
              if (data.messageId) appliedSeqRef.current.delete(data.messageId);
              // Don't surface a failure via the bottom banner here: the server
              // has already persisted it on the message row (taskStatus:"failed"
              // + error), so the reload below brings it back as the message's own
              // durable ErrorNotice. Setting `error` would only flash the banner
              // for the one render before loadHistory() clears it again — an
              // unreadable red blink above the composer. The banner is reserved
              // for load errors (loadHistory's own catch).
              loadHistory();
              break;
            }

            case "task:notice": {
              // The provider stalled and the runner is re-streaming. Surface a
              // calm "model is slow, retrying" instead of a silent pause; the next
              // content delta clears it (see the GATED apply path above).
              if (data.notice.kind === "retrying") {
                setTaskInfo((prev) => ({ ...prev, retrying: { attempt: data.notice.attempt, max: data.notice.max } }));
              }
              break;
            }

            case "new_message": {
              // External message (e.g. Telegram) — reload
              loadHistory();
              break;
            }

            case "chat:compacted": {
              // A compaction checkpoint landed — reload so the transcript shows
              // the divider and the context meter re-derives from the new leaf.
              loadHistory();
              break;
            }
          }
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        sseHealthyRef.current = false;
        es?.close();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
    };

    connect();
    return () => {
      sseHealthyRef.current = false;
      clearTimeout(reconnectTimer);
      clearTimeout(truncReloadTimer);
      clearTimeout(reconcileTimer);
      es?.close();
    };
  }, [chatId, loadHistory]);

  // ── Polling fallback — only really needed when SSE is down ──
  useEffect(() => {
    if (status !== "running") return;

    let ticks = 0;
    const poll = setInterval(() => {
      ticks += 1;
      // When SSE is healthy it already delivers task:finish — running a full
      // poll alongside it every 3s is wasted load. Poll aggressively only while
      // SSE is down; otherwise keep a light insurance check (~every 21s).
      if (sseHealthyRef.current && ticks % 7 !== 0) return;

      fetch(`/api/tasks?chatId=${chatId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((task) => {
          if (!task || task.status !== "running") {
            setStatus("idle");
            setTaskId(null);
            loadHistory();
            clearInterval(poll);
          }
        })
        .catch(() => {});
    }, 3000);

    return () => clearInterval(poll);
  }, [status, chatId, loadHistory]);

  // ── Ensure chat row exists in DB (needed before file upload) ──
  const ensureChatRef = useRef(false);
  const ensureChat = useCallback(async () => {
    if (ensureChatRef.current) return;
    ensureChatRef.current = true;
    await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: chatId, projectId }),
    }).catch(() => {}); // ignore conflict (chat already exists)
  }, [chatId, projectId]);

  // ── Send message ───────────────────────────────────────────
  // Attachments arrive already uploaded (the composer uploads eagerly on attach,
  // so the bytes are in the sandbox before send) — we only carry their refs here.
  const sendMessage = useCallback(
    async (text: string, model: string, attachedFiles?: FileRef[], messageId?: string) => {
      const files = attachedFiles ?? [];
      if (!text.trim() && files.length === 0) return;

      const displayText = text.trim() || (files.length > 0 ? t("processFiles") : "");

      // A chat that still has no messages is being created by this very send —
      // it isn't in the sidebar yet (the row only lands once the DB row exists).
      // Tell the sidebar NOW so it can drop the row in optimistically, before the
      // POST round-trips, instead of popping in ~400ms later via the SSE refresh.
      const isFirstMessage = msgRef.current.length === 0;

      // Optimistically add the user message. Carry the attachment refs in
      // metadata so the bubble shows thumbnails immediately — before history
      // reloads — matching what the server persists.
      const userMsg: Message = {
        // A stable id supplied by the caller (the send queue) makes the whole
        // send idempotent: the server upserts on this id (onConflictDoNothing),
        // so the same queued message draining from two tabs collapses to one row
        // instead of producing a duplicate bubble.
        id: messageId ?? nanoid(),
        role: "user",
        parts: [{ type: "text", text: displayText }],
        metadata: files.length > 0 ? { attachedFiles: files } : undefined,
      };
      const currentMessages = [...msgRef.current, userMsg];
      setMessages(currentMessages);
      setStatus("running");
      if (isFirstMessage && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("chat:created", {
            detail: { id: chatId, title: displayText.slice(0, 100), projectId: projectId ?? null },
          }),
        );
      }
      // Preserve this message across any reload until it's durably persisted —
      // a prior turn finishing mid-POST would otherwise reload it away.
      pendingRef.current = [...pendingRef.current, userMsg];

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            projectId,
            model,
            userMessage: displayText,
            userMessageId: userMsg.id,
            attachedFiles: files.length > 0 ? files : undefined,
            messages: currentMessages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
            })),
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          // Budget exhaustion shares the 429 status with rate limiting — tell
          // them apart by code so the user gets the right message.
          if (err?.code === "BUDGET_EXCEEDED") throw new Error(t("budgetReached"));
          if (res.status === 429) throw new Error(t("rateLimited"));
          throw new Error(err?.error || t("requestFailed"));
        }

        const { taskId: newTaskId } = await res.json();
        setTaskId(newTaskId);
      } catch (e) {
        pendingRef.current = pendingRef.current.filter((m) => m.id !== userMsg.id);
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        setStatus("idle");
        throw e;
      }
    },
    [chatId, projectId, t],
  );

  // ── Re-run the tail (regenerate / edit) ────────────────────
  // Both share a shape: truncate the DB from a point, set the optimistic
  // history, then POST to /api/chat. Omitting `model` lets the server reuse the
  // chat's persisted model. An empty userMessage means "don't insert a new user
  // row" (regenerate); a non-empty one re-inserts the edited message (edit).
  const rerun = useCallback(
    async (history: Message[], userMessage: string, userMessageId?: string, attachedFiles?: FileRef[]) => {
      // Non-destructive: the server inserts a sibling branch keyed off the
      // history we send, so the previous version stays reachable via ‹ i/N ›.
      setMessages(history);
      setStatus("running");
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            projectId,
            userMessage,
            userMessageId,
            // Edit only changes the text — the original attachments ride along so
            // the server re-persists them and the runner re-feeds them to the model.
            attachedFiles: attachedFiles?.length ? attachedFiles : undefined,
            messages: history.map((m) => ({ id: m.id, role: m.role, parts: m.parts })),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          // Budget exhaustion shares the 429 status with rate limiting — tell
          // them apart by code so the user gets the right message.
          if (err?.code === "BUDGET_EXCEEDED") throw new Error(t("budgetReached"));
          if (res.status === 429) throw new Error(t("rateLimited"));
          throw new Error(err?.error || t("requestFailed"));
        }
        const { taskId: newTaskId } = await res.json();
        setTaskId(newTaskId);
      } catch (e) {
        setStatus("idle");
        loadHistory(); // the DB and UI may now disagree — resync from source
        throw e;
      }
    },
    [chatId, projectId, t, loadHistory],
  );

  // Regenerate: drop the latest assistant reply and re-run the same prompt.
  const regenerate = useCallback(async () => {
    const msgs = msgRef.current;
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx === -1) return;
    const history = msgs.slice(0, lastAssistantIdx);
    if (!history.some((m) => m.role === "user")) return;
    await rerun(history, "");
  }, [rerun]);

  // Edit: replace a user message's text and re-run from there.
  const editMessage = useCallback(async (messageId: string, newText: string) => {
    const text = newText.trim();
    if (!text) return;
    const msgs = msgRef.current;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const history = msgs.slice(0, idx);
    // Editing rewrites the text but keeps whatever the user had attached — carry
    // the refs into the new message's metadata (so the bubble shows thumbnails
    // optimistically) and through rerun (so the server re-persists + re-feeds them).
    const attachedFiles = (msgs[idx].metadata as { attachedFiles?: FileRef[] } | undefined)?.attachedFiles;
    const edited: Message = {
      id: nanoid(),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: attachedFiles?.length ? { attachedFiles } : undefined,
    };
    await rerun([...history, edited], text, edited.id, attachedFiles);
  }, [rerun]);

  // ── Switch branch (‹ i/N › version arrows) ─────────────────
  // Point the chat at another sibling's branch, then resync from the server,
  // which returns that branch as the visible conversation.
  const switchBranch = useCallback(async (messageId: string, direction: "prev" | "next") => {
    await fetch("/api/chat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, messageId, direction }),
    }).catch(() => {});
    loadHistory();
  }, [chatId, loadHistory]);

  // ── Fork from a message into a new independent chat ─────────
  const forkChat = useCallback(async (fromMessageId: string): Promise<string | null> => {
    const res = await fetch("/api/chats/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, fromMessageId }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const { id } = (await res.json()) as { id: string };
    return id;
  }, [chatId]);

  // ── Stop / Cancel ──────────────────────────────────────────
  const stop = useCallback(async () => {
    // The taskId may be unknown to this client even while it shows "running":
    // a turn started elsewhere (Telegram, another tab) or via an SSE task:start
    // we adopted without a local POST, or a reconnect that found a running
    // message. Resolve the chat's live task on demand so the button is never a
    // dead no-op. If nothing is actually running, clear the stuck spinner anyway
    // — that itself un-hangs a chat the UI wrongly believes is still working.
    let id = taskId;
    if (!id) {
      id = await fetch(`/api/tasks?chatId=${chatId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((task) => (task?.status === "running" ? (task.id as string) : null))
        .catch(() => null);
    }
    if (id) {
      await fetch(`/api/tasks/${id}/cancel`, { method: "POST" }).catch(() => {});
    }
    setStatus("idle");
    setTaskId(null);
  }, [taskId, chatId]);

  // A tool call is suspended awaiting the user — a `manage` approval OR an `ask`
  // question. The composer blocks (like Claude Code) so the card is the only next
  // action. Once decided/answered the part leaves the awaiting state, so this
  // clears itself.
  const awaitingInput = messages.some(
    (m) => m.role === "assistant" && m.parts.some((p) =>
      p.type === "dynamic-tool" && (p.state === "approval-requested" || (p.toolName === "ask" && p.askForm && p.state === "input-available")),
    ),
  );

  return { messages, status, error, sendMessage, regenerate, editMessage, switchBranch, forkChat, stop, ensureChat, reload: loadHistory, isLoading: status === "running", awaitingInput, taskInfo };
}
