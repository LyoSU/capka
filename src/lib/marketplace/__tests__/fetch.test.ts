import { describe, it, expect, vi } from "vitest";
import { parseMarketplace, resolveCommit, ghTree, diffTrees, type TreeEntry } from "../fetch";

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe("resolveCommit", () => {
  it("pins a ref to its concrete commit (sha + first-line message + date)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ sha: "abc123", commit: { message: "feat: thing\n\nbody", committer: { date: "2026-01-02T03:04:05Z" } } }),
    );
    const c = await resolveCommit("o", "r", "main", fetchFn as unknown as typeof fetch);
    expect(c).toEqual({ sha: "abc123", date: "2026-01-02T03:04:05Z", message: "feat: thing" });
    expect(fetchFn).toHaveBeenCalledWith("https://api.github.com/repos/o/r/commits/main");
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 404));
    await expect(resolveCommit("o", "r", "nope", fetchFn as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });
});

describe("diffTrees", () => {
  const blob = (path: string, sha: string): TreeEntry => ({ path, type: "blob", sha });

  it("classifies added / removed / modified blobs by content sha, relative to the prefix", () => {
    const oldTree = [blob("p/keep.md", "1"), blob("p/changes.md", "2"), blob("p/gone.md", "3")];
    const newTree = [blob("p/keep.md", "1"), blob("p/changes.md", "9"), blob("p/new.md", "4")];
    expect(diffTrees(oldTree, newTree, "p/")).toEqual({
      added: ["new.md"],
      removed: ["gone.md"],
      modified: ["changes.md"],
    });
  });

  it("ignores tree (directory) entries and paths outside the prefix", () => {
    const oldTree = [{ path: "p/dir", type: "tree", sha: "t" } as TreeEntry, blob("other/x.md", "1")];
    const newTree = [{ path: "p/dir", type: "tree", sha: "t2" } as TreeEntry, blob("other/x.md", "9")];
    expect(diffTrees(oldTree, newTree, "p/")).toEqual({ added: [], removed: [], modified: [] });
  });
});

describe("ghTree", () => {
  it("carries each entry's blob sha (content hash) so trees can be diffed", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ tree: [{ path: "a.md", type: "blob", sha: "deadbeef" }, { path: "dir", type: "tree", sha: "treesha" }] }),
    );
    const tree = await ghTree("o", "r", "abc123", fetchFn as unknown as typeof fetch);
    expect(tree).toEqual([
      { path: "a.md", type: "blob", sha: "deadbeef" },
      { path: "dir", type: "tree", sha: "treesha" },
    ]);
  });
});

describe("parseMarketplace", () => {
  const mkt = { owner: "anthropics", repo: "claude-plugins-official" };

  it("normalizes the real official-marketplace shape", () => {
    const json = {
      name: "claude-plugins-official",
      owner: { name: "Anthropic", email: "x@y.z" },
      plugins: [
        {
          name: "42crunch", description: "API security", author: { name: "42Crunch" }, category: "security",
          source: { source: "git-subdir", url: "https://github.com/42Crunch-AI/claude-plugins.git", path: "plugins/api-security-testing", ref: "v1.5.5", sha: "bc781f" },
          homepage: "https://42crunch.com",
        },
      ],
    };
    const { name, owner, items } = parseMarketplace(json, mkt);
    expect(name).toBe("claude-plugins-official");
    expect(owner).toBe("Anthropic");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "42crunch", author: "42Crunch", category: "security", installable: true });
  });

  it("skips malformed entries and marks non-GitHub sources not installable", () => {
    const json = {
      name: "m",
      plugins: [
        { description: "no name" },
        { name: "npm-thing", source: { source: "npm", url: "npm:left-pad" } },
      ],
    };
    const { items } = parseMarketplace(json, mkt);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("npm-thing");
    expect(items[0].installable).toBe(false);
  });
});
