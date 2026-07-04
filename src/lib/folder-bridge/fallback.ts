/**
 * Non-Chromium fallback: a ONE-SHOT folder import (no live binding). Firefox and
 * Safari have refused `showDirectoryPicker`, so instead of syncing we bulk-upload
 * a picked directory into /workspace/<name>/… once; the user gets the result back
 * via the existing "download as zip" route. Uses a plain `<input webkitdirectory>`
 * — exactly what a File-System-Access polyfill does under the hood — so there's no
 * dependency to install (and nothing new for a self-hoster's container to miss).
 */

import { ignoredPath, oversized, exceedsCeiling, sanitizeFolderName, FolderTooLargeError } from "./filter";
import { uploadBatch } from "./bridge";

/** Open the OS directory picker via a hidden `<input webkitdirectory>` and resolve
 *  the chosen files (each carries `webkitRelativePath`). Resolves [] on cancel. */
function pickDirectory(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(input.files ? Array.from(input.files) : []), { once: true });
    // Cancellation is detected by the `cancel` event (fired when the picker is
    // dismissed) — precise, unlike the old focus+timeout heuristic that could drop
    // a real selection whose `change` fired later than the timer for a large folder.
    input.addEventListener("cancel", () => done([]), { once: true });
    // Backstop only, for the rare browser that fires neither event: release the
    // spinner after a generous delay. Long enough that even a large directory's
    // `change` always wins the race first (it flips `settled`), so a real selection
    // is never dropped.
    window.addEventListener("focus", () => setTimeout(() => done([]), 10_000), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export async function importFolderFallback(chatId: string): Promise<{ name: string; count: number } | null> {
  const picked = await pickDirectory();
  if (picked.length === 0) return null;

  const root = (picked[0].webkitRelativePath || picked[0].name).split("/")[0] || "folder";
  const name = sanitizeFolderName(root) || "folder";

  // Drop the same junk the live sync skips (node_modules/models/oversized) so a
  // one-shot import doesn't haul a dependency tree into the sandbox either. Map
  // each survivor to its path relative to the folder root.
  const byRel = new Map<string, File>();
  for (const f of picked) {
    const rel = f.webkitRelativePath || f.name; // "<root>/sub/file.txt"
    const inner = rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel;
    if (ignoredPath(inner) || oversized(f.size)) continue;
    byRel.set(inner, f);
  }
  if (byRel.size === 0) return { name, count: 0 };

  // Same attach ceiling as live sync — refuse a huge import up front (before writing
  // anything) rather than grinding through it and possibly failing part-way.
  const bytes = [...byRel.values()].reduce((sum, f) => sum + f.size, 0);
  if (exceedsCeiling(byRel.size, bytes)) throw new FolderTooLargeError(byRel.size, bytes);

  // Reuse the live-sync batch upload (same endpoint, chunking, and rate-limit
  // handling) so the two paths can't drift.
  await uploadBatch(chatId, name, [...byRel.keys()], async (rel) => byRel.get(rel)!);
  return { name, count: byRel.size };
}
