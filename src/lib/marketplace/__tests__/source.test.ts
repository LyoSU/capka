import { describe, it, expect } from "vitest";
import { parseGitHubUrl, resolveGitHub } from "../source";

describe("parseGitHubUrl", () => {
  it("parses https + .git + owner/repo shorthand", () => {
    expect(parseGitHubUrl("https://github.com/anthropics/skills.git")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseGitHubUrl("https://github.com/anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills" });
    expect(parseGitHubUrl("anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills" });
  });
  it("returns null for non-GitHub", () => {
    expect(parseGitHubUrl("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("resolveGitHub", () => {
  const mkt = { owner: "acme", repo: "market" };
  it("git-subdir: sha wins over ref, path is the subdir", () => {
    expect(resolveGitHub({ source: "git-subdir", url: "https://github.com/x/y.git", path: "plugins/a", ref: "v1", sha: "abc" }, mkt))
      .toEqual({ owner: "x", repo: "y", ref: "abc", subdir: "plugins/a" });
  });
  it("github form via repo + ref fallback to HEAD", () => {
    expect(resolveGitHub({ source: "github", repo: "x/y" }, mkt))
      .toEqual({ owner: "x", repo: "y", ref: "HEAD", subdir: "" });
  });
  it("bare relative string resolves within the marketplace repo", () => {
    expect(resolveGitHub("./plugins/foo", mkt))
      .toEqual({ owner: "acme", repo: "market", ref: "HEAD", subdir: "plugins/foo" });
  });
  it("non-GitHub git url is not resolvable", () => {
    expect(resolveGitHub({ source: "git", url: "https://gitlab.com/a/b" }, mkt)).toBeNull();
  });
});
