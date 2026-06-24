import { describe, it, expect } from "vitest";
import { downloadAllPaths, canDownloadAll } from "../workspace-paths";

const f = (name: string, isDirectory: boolean) => ({ name, path: name, isDirectory });

describe("downloadAllPaths — what 'Download all' hands the recursive archiver", () => {
  it("includes folders so `zip -r` recurses into subfolders (the reported bug)", () => {
    const entries = [f("src", true), f("readme.md", false)];
    expect(downloadAllPaths(entries)).toContain("src");
    expect(downloadAllPaths(entries)).toContain("readme.md");
  });

  it("excludes hidden dotfiles and dotfolders, matching the file list", () => {
    const entries = [f(".git", true), f(".env", false), f("app.ts", false)];
    expect(downloadAllPaths(entries)).toEqual(["app.ts"]);
  });

  it("returns an empty list for an empty folder", () => {
    expect(downloadAllPaths([])).toEqual([]);
  });
});

describe("canDownloadAll — when the bulk-download button is offered", () => {
  it("offers download for a folders-only directory like the workspace root (the reported bug)", () => {
    // Folders have no per-row download control, so hiding the bulk button here
    // made the entire subtree un-downloadable.
    expect(canDownloadAll(3, 0)).toBe(true);
  });

  it("offers download for a single folder", () => {
    expect(canDownloadAll(1, 0)).toBe(true);
  });

  it("hides the button for a lone file — its own row already has a download", () => {
    expect(canDownloadAll(0, 1)).toBe(false);
  });

  it("offers download once there is more than one file", () => {
    expect(canDownloadAll(0, 2)).toBe(true);
  });

  it("hides the button for an empty folder", () => {
    expect(canDownloadAll(0, 0)).toBe(false);
  });
});
