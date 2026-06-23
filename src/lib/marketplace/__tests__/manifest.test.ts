import { describe, it, expect } from "vitest";
import { extractServers, parseManifestMcp } from "../manifest";

describe("extractServers", () => {
  it("unwraps the standard { mcpServers } envelope", () => {
    const got = extractServers({ mcpServers: { db: { url: "https://db" } } });
    expect(got).toEqual({ db: { url: "https://db" } });
  });

  it("tolerates a bare server map (no mcpServers wrapper)", () => {
    const got = extractServers({ db: { command: "npx" } });
    expect(got).toEqual({ db: { command: "npx" } });
  });

  it("returns empty for non-objects", () => {
    expect(extractServers(null)).toEqual({});
    expect(extractServers("nope")).toEqual({});
  });
});

describe("parseManifestMcp", () => {
  it("reads the inline object form", () => {
    const got = parseManifestMcp({ db: { url: "https://db" } });
    expect(got.inline).toEqual({ db: { url: "https://db" } });
    expect(got.paths).toEqual([]);
  });

  it("reads a string path form and strips a leading ./", () => {
    const got = parseManifestMcp("./mcp-config.json");
    expect(got.paths).toEqual(["mcp-config.json"]);
    expect(got.inline).toEqual({});
  });

  it("reads an array of path strings", () => {
    const got = parseManifestMcp(["./a.json", "config/b.json"]);
    expect(got.paths).toEqual(["a.json", "config/b.json"]);
    expect(got.inline).toEqual({});
  });

  it("reads an array mixing paths and inline objects", () => {
    const got = parseManifestMcp(["./a.json", { db: { url: "https://db" } }]);
    expect(got.paths).toEqual(["a.json"]);
    expect(got.inline).toEqual({ db: { url: "https://db" } });
  });

  it("rejects path traversal in referenced config paths", () => {
    expect(parseManifestMcp("../../../etc/passwd").paths).toEqual([]);
    expect(parseManifestMcp(["/abs/path.json", "../escape.json"]).paths).toEqual([]);
  });

  it("returns empty for junk values", () => {
    expect(parseManifestMcp(42)).toEqual({ inline: {}, paths: [] });
    expect(parseManifestMcp(null)).toEqual({ inline: {}, paths: [] });
    expect(parseManifestMcp(undefined)).toEqual({ inline: {}, paths: [] });
  });
});
