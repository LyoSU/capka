/**
 * Copy text to the clipboard, including where the async Clipboard API isn't there.
 *
 * `navigator.clipboard` is gated on a SECURE context, and Capka is routinely
 * self-hosted at a bare `http://<ip>:3000` — no TLS, no localhost exemption. On
 * those deployments the API is absent entirely, so every copy button (share link,
 * reply text, master key, Telegram link code) silently did nothing. The legacy
 * `execCommand("copy")` path still works there, as long as it runs inside the
 * user's click handler — so this must be called directly from an event handler,
 * not after an `await` that yields the user-activation.
 *
 * Returns whether the text made it, so the caller can show "Copied" honestly
 * instead of assuming success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Present but refused (permission policy, or a cross-origin iframe) — the
    // legacy path below is often still allowed, so fall through rather than fail.
  }

  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    // readonly keeps the mobile keyboard from opening; the off-screen 1px box
    // keeps the page from scrolling to a textarea the user never sees.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // In `finally` so a throw mid-way can't leak the scratch node into the page.
    // Guarded: a throw HERE would replace the value the `try` already returned.
    try {
      document.body.removeChild(ta);
    } catch {
      /* never appended */
    }
  }
}
