"use client";

import { useEffect, useRef } from "react";

import { prefixTitle, type TabState } from "@/lib/tab-state";

const DOT = { needs: "#d97706", working: "#6b7280", done: "#16a34a" } as const;

/** Mirrors `state` into the tab title, the favicon and the installed app's badge.
 *
 *  The title is shared with Next's streamed metadata and ChatTitleSync, both of
 *  which write a bare title whenever they like — so instead of writing once we
 *  watch `<title>` and put our prefix back whenever someone else's write drops it.
 *  The favicon is the existing /favicon.png with a dot drawn in its corner. */
export function useTabState(state: TabState) {
  const { kind, count } = state;
  const iconRef = useRef<Promise<HTMLImageElement | null> | null>(null);

  useEffect(() => {
    const apply = () => {
      const next = prefixTitle(document.title, { kind, count });
      if (next !== document.title) document.title = next;
    };
    apply();
    // The whole head, not the <title> node: a navigation can replace that node.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [kind, count]);

  useEffect(() => {
    // The favicon <link>s are Next's; we only swap their href and keep the
    // original in a data attribute so idle puts the plain icon back.
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const restore = () => {
      for (const l of links) if (l.dataset.plainHref) l.href = l.dataset.plainHref;
    };
    if (kind === "idle") return restore();
    iconRef.current ??= new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = "/favicon.png";
    });
    let cancelled = false;
    void iconRef.current.then((img) => {
      if (cancelled || !img) return;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 32, 32);
      ctx.beginPath();
      ctx.arc(24, 24, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(24, 24, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = DOT[kind];
      ctx.fill();
      const url = canvas.toDataURL("image/png");
      for (const l of links) {
        l.dataset.plainHref ??= l.href;
        l.href = url;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  useEffect(() => {
    // Installed-PWA badge (Chromium desktop, some Android launchers). Silently
    // absent elsewhere; a rejected promise just means the platform said no.
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge || !nav.clearAppBadge) return;
    (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => {});
  }, [count]);
}
