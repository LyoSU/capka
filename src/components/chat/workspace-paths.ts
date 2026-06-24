/** Pure helpers for the workspace file panel — no React, so they're unit-testable
 *  in the node test environment. */

export type WorkspaceEntry = { name: string; path: string; isDirectory: boolean };

/** The paths "Download all" hands to the recursive archiver (`zip -r`).
 *
 *  Folders MUST be included: the server archives each path with `zip -r`, so a
 *  folder path pulls in its whole subtree. The previous version passed only the
 *  current folder's files, which (a) skipped every subfolder and (b) meant you
 *  had to open and download each folder by hand. Hidden dot-entries are excluded
 *  to match what the panel shows. */
export function downloadAllPaths(entries: WorkspaceEntry[]): string[] {
  return entries.filter((e) => !e.name.startsWith(".")).map((e) => e.path);
}

/** Whether the panel shows its "Download all" button.
 *
 *  Folders count, not just files: a folder has no per-row download control, so a
 *  directory holding only folders (e.g. the workspace root) MUST still offer bulk
 *  download — otherwise the whole subtree is un-downloadable. (The button gated on
 *  the file-only count before, so a folders-only root hid it entirely.) A lone
 *  file is excluded because its own row already carries a download button. */
export function canDownloadAll(folderCount: number, fileCount: number): boolean {
  return folderCount > 0 || fileCount > 1;
}
