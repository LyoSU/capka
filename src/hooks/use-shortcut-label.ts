"use client";

import { useEffect, useState } from "react";

/**
 * Renders a keyboard shortcut the way the reader's own keyboard is labelled:
 * `⌘⇧F` on Apple hardware, `Ctrl+Shift+F` everywhere else.
 *
 * Resolved after mount rather than during render — `navigator` does not exist on
 * the server, and guessing would make the first paint disagree with the markup.
 * Non-Apple is the safe default: `Ctrl+K` on a Mac is merely wrong for one
 * frame, while `⌘K` on Windows names a key that isn't there.
 */
export function useShortcutLabel() {
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  return (key: string, shift = false) =>
    mac ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}
