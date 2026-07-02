import { describe, it, expect, vi } from "vitest";
import { discoverSkills } from "../discover";

const commit = { sha: "abc123def", commit: { message: "chore: skills\n\nbody", committer: { date: "2026-02-03T00:00:00Z" } } };

const tree = {
  tree: [
    { path: "README.md", type: "blob", sha: "r" },
    { path: "skills", type: "tree", sha: "d0" },
    { path: "skills/linkedin-post", type: "tree", sha: "d1" },
    { path: "skills/linkedin-post/SKILL.md", type: "blob", sha: "s1" },
    { path: "skills/linkedin-post/reference.md", type: "blob", sha: "x1" },
    { path: "skills/x-post", type: "tree", sha: "d2" },
    { path: "skills/x-post/SKILL.md", type: "blob", sha: "s2" },
  ],
};

const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nDo the thing.`;

/** Route a stubbed fetch by URL so one mock serves commit + tree + each raw file. */
function stubFetch(): typeof fetch {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const j = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), body: null, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
    const raw = (text: string) => ({ ok: true, status: 200, headers: new Headers(), body: null, text: async () => text }) as unknown as Response;
    if (u.includes("/commits/")) return j(commit);
    if (u.includes("/git/trees/")) return j(tree);
    if (u.endsWith("/skills/linkedin-post/SKILL.md")) return raw(md("linkedin-post", "Post to LinkedIn"));
    if (u.endsWith("/skills/x-post/SKILL.md")) return raw(md("x-post", "Post to X"));
    return { ok: false, status: 404, headers: new Headers(), body: null, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("discoverSkills", () => {
  it("lists every skills/<name>/SKILL.md with its parsed name + description, pinned to a commit", async () => {
    const res = await discoverSkills({ owner: "publora", repo: "skills", ref: "HEAD", subdir: "" }, stubFetch());
    expect(res.commit.sha).toBe("abc123def");
    expect(res.skills).toEqual([
      { name: "linkedin-post", description: "Post to LinkedIn" },
      { name: "x-post", description: "Post to X" },
    ]);
  });

  it("skips non-skill blobs (a stray README) and only reads SKILL.md files", async () => {
    const res = await discoverSkills({ owner: "publora", repo: "skills", ref: "HEAD", subdir: "" }, stubFetch());
    expect(res.skills.map((s) => s.name)).not.toContain("README");
  });
});
