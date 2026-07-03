import { directoryOpen } from "browser-fs-access";

/**
 * Non-Chromium fallback: a ONE-SHOT folder import (no live binding). Firefox and
 * Safari have refused `showDirectoryPicker`, so instead of syncing we bulk-upload
 * a picked directory into /workspace/<name>/… once; the user gets the result back
 * via the existing "download as zip" route. browser-fs-access degrades to a
 * `<input webkitdirectory>` under the hood.
 */
export async function importFolderFallback(chatId: string): Promise<{ name: string; count: number } | null> {
  const files = (await directoryOpen({ recursive: true }).catch(() => null)) as (File & { webkitRelativePath?: string })[] | null;
  if (!files || files.length === 0) return null;

  const first = files[0].webkitRelativePath || files[0].name;
  const name = first.split("/")[0] || "folder";

  for (const f of files) {
    const rel = f.webkitRelativePath || f.name; // "<name>/sub/file.txt"
    const slash = rel.lastIndexOf("/");
    const dir = slash >= 0 ? rel.slice(0, slash) : name;
    const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
    const form = new FormData();
    form.append("chatId", chatId);
    form.append("path", dir);
    form.append("file", new File([f], filename));
    await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
  }
  return { name, count: files.length };
}
