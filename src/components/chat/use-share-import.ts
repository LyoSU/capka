"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { detectShareLink } from "@/lib/import/detect";
import type { DetectedShareLink, SharedChatImport } from "@/lib/import/types";

/**
 * Detects a pasted share link in the composer and drives the two-step import:
 * `preview` (render + parse in the sandbox, no writes) → `commit` (create the
 * chat). Imports ONLY the barrel-free `detect`/types modules so the server-only
 * render pipeline never leaks into the client bundle.
 *
 * State machine, all keyed to the currently-detected URL (changing the composer
 * text resets it):
 *   idle → previewing → preview → committing → (redirect via onImported)
 *   any step → error (with a machine code the card localizes)
 */
export type ImportPhase =
  | { phase: "idle" }
  | { phase: "previewing" }
  | { phase: "preview"; data: SharedChatImport }
  | { phase: "committing"; data: SharedChatImport }
  | { phase: "error"; code: string };

function codeFromResponse(body: unknown): string {
  const code = (body as { code?: string })?.code;
  if (typeof code === "string" && code.startsWith("IMPORT_")) return code.slice("IMPORT_".length);
  return "RENDER_FAILED";
}

export function useShareImport(opts: { text: string; model: string; onImported: (chatId: string) => void }) {
  const { text, model, onImported } = opts;
  const detected = useMemo(() => detectShareLink(text), [text]);
  // Once the user chooses "just send", stop offering for that exact URL so the
  // card doesn't nag while they finish typing / hit send.
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);
  const [state, setState] = useState<ImportPhase>({ phase: "idle" });

  // Reset the moment the detected link changes (new paste, edited text). Done as
  // the "store info from previous render" pattern (React docs) rather than an
  // effect, so it happens before paint with no cascading re-render.
  const lastUrl = useRef(detected?.url);
  if (lastUrl.current !== detected?.url) {
    lastUrl.current = detected?.url;
    setState({ phase: "idle" });
  }

  const active: DetectedShareLink | null = detected && detected.url !== dismissedUrl ? detected : null;

  const startPreview = useCallback(async () => {
    if (!active) return;
    setState({ phase: "previewing" });
    try {
      const res = await fetch("/api/chats/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: active.url }),
      });
      if (!res.ok) {
        setState({ phase: "error", code: codeFromResponse(await res.json().catch(() => ({}))) });
        return;
      }
      setState({ phase: "preview", data: (await res.json()) as SharedChatImport });
    } catch {
      setState({ phase: "error", code: "RENDER_FAILED" });
    }
  }, [active]);

  // Guards a double commit: StrictMode double-invokes render/updaters (never event
  // handlers), and an impatient double-click fires this twice — either would
  // create two chats. The side effect lives in the handler body (NOT inside a
  // setState updater, which must stay pure) and this ref makes it fire once.
  const committingRef = useRef(false);
  const confirmImport = useCallback(async () => {
    if (committingRef.current || state.phase !== "preview") return;
    const data = state.data;
    committingRef.current = true;
    setState({ phase: "committing", data });
    try {
      const res = await fetch("/api/chats/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: data.source, title: data.title, messages: data.messages, model }),
      });
      if (!res.ok) {
        setState({ phase: "error", code: "RENDER_FAILED" });
        return;
      }
      const { id } = (await res.json()) as { id: string };
      onImported(id);
    } catch {
      setState({ phase: "error", code: "RENDER_FAILED" });
    } finally {
      committingRef.current = false;
    }
  }, [state, model, onImported]);

  const dismiss = useCallback(() => {
    if (detected) setDismissedUrl(detected.url);
    setState({ phase: "idle" });
  }, [detected]);

  // From an error, let the user try the whole thing again.
  const retry = useCallback(() => setState({ phase: "idle" }), []);

  return { detected: active, state, startPreview, confirmImport, dismiss, retry };
}
