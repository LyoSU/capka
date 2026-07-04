/**
 * Non-Chromium fallback: a ONE-SHOT folder import (no live binding). Firefox and
 * Safari have refused `showDirectoryPicker`, so instead of syncing we bulk-upload
 * a picked directory into /workspace/<name>/… once; the user gets the result back
 * via the existing "download as zip" route. Uses a plain `<input webkitdirectory>`
 * — exactly what a File-System-Access polyfill does under the hood — so there's no
 * dependency to install (and nothing new for a self-hoster's container to miss).
 */

import { ignoredPath, oversized, exceedsCeiling, FolderTooLargeError } from "./filter";

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
    // A cancelled picker fires no event; when the window regains focus with nothing
    // chosen, treat it as cancelled. The `change` event, if any, wins the race
    // (it flips `settled` first), so a real selection is never dropped.
    window.addEventListener("focus", () => setTimeout(() => done([]), 500), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

const CHUNK = 100;

export async function importFolderFallback(chatId: string): Promise<{ name: string; count: number } | null> {
  const picked = await pickDirectory();
  if (picked.length === 0) return null;

  const first = picked[0].webkitRelativePath || picked[0].name;
  const name = first.split("/")[0] || "folder";

  // Drop the same junk the live sync skips (node_modules/models/oversized) so a
  // one-shot import doesn't haul a dependency tree into the sandbox either.
  const files = picked.filter((f) => {
    const rel = f.webkitRelativePath || f.name;
    const inner = rel.startsWith(`${name}/`) ? rel.slice(name.length + 1) : rel;
    return !ignoredPath(inner) && !oversized(f.size);
  });
  if (files.length === 0) return { name, count: 0 };

  // Same attach ceiling as live sync — refuse a huge import up front (before writing
  // anything) rather than grinding through it and possibly failing part-way.
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  if (exceedsCeiling(files.length, bytes)) throw new FolderTooLargeError(files.length, bytes);

  // Batch through the folder-sync endpoint (rate-limited per request), so a big
  // folder doesn't trip the interactive per-file upload limiter. Each file's form
  // name is its path relative to the folder root.
  for (let i = 0; i < files.length; i += CHUNK) {
    const form = new FormData();
    form.append("chatId", chatId);
    form.append("name", name);
    for (const f of files.slice(i, i + CHUNK)) {
      const rel = f.webkitRelativePath || f.name; // "<name>/sub/file.txt"
      const inner = rel.startsWith(`${name}/`) ? rel.slice(name.length + 1) : rel;
      form.append("files", new File([f], inner));
    }
    const res = await fetch("/api/folders/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error("import failed");
  }
  return { name, count: files.length };
}
