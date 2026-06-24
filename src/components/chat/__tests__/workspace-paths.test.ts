import { describe, it, expect } from "vitest";
import { downloadAllPaths } from "../workspace-paths";

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
