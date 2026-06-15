import { describe, it, expect } from "vitest";
import { parseMarketplace } from "../fetch";

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
