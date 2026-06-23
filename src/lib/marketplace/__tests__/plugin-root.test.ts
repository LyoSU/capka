import { describe, it, expect } from "vitest";
import {
  refsPluginRoot,
  hasUnresolvedPlaceholder,
  substituteServerSpec,
  selectPluginFiles,
  pluginBaseDir,
} from "../plugin-root";

describe("refsPluginRoot", () => {
  it("detects a ${CLAUDE_PLUGIN_ROOT} reference in any part", () => {
    expect(refsPluginRoot(["${CLAUDE_PLUGIN_ROOT}/servers/db"])).toBe(true);
    expect(refsPluginRoot(["node", "${CLAUDE_PLUGIN_DATA}/x"])).toBe(true);
  });
  it("is false for plain commands", () => {
    expect(refsPluginRoot(["npx", "@scope/pkg", undefined])).toBe(false);
    expect(refsPluginRoot([])).toBe(false);
  });
});

describe("hasUnresolvedPlaceholder", () => {
  it("ignores runtime-resolvable placeholders", () => {
    expect(hasUnresolvedPlaceholder("${CLAUDE_PLUGIN_ROOT}/bin")).toBe(false);
    expect(hasUnresolvedPlaceholder("${CLAUDE_PLUGIN_DATA}/db")).toBe(false);
  });
  it("flags a real secret/user-config placeholder", () => {
    expect(hasUnresolvedPlaceholder("${API_KEY}")).toBe(true);
    expect(hasUnresolvedPlaceholder("${CLAUDE_PLUGIN_ROOT}/x ${TOKEN}")).toBe(true);
  });
  it("is false for plain strings", () => {
    expect(hasUnresolvedPlaceholder("just/a/path")).toBe(false);
  });
});

describe("substituteServerSpec", () => {
  it("substitutes across command, args and env", () => {
    const out = substituteServerSpec(
      { command: "${CLAUDE_PLUGIN_ROOT}/bin/srv", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"], env: { DB: "${CLAUDE_PLUGIN_DATA}/db" } },
      "/plugins/abc",
    );
    expect(out.command).toBe("/plugins/abc/bin/srv");
    expect(out.args).toEqual(["--root", "/plugins/abc"]);
    expect(out.env).toEqual({ DB: "/plugins/abc/.data/db" });
  });
  it("leaves a spec without placeholders untouched", () => {
    const spec = { command: "npx", args: ["pkg"] };
    expect(substituteServerSpec(spec, "/plugins/abc")).toEqual(spec);
  });
});

describe("pluginBaseDir", () => {
  it("derives the sandbox base dir from an install id", () => {
    expect(pluginBaseDir("abc123")).toBe("/plugins/abc123");
  });
  it("rejects an unsafe install id", () => {
    expect(() => pluginBaseDir("../../etc")).toThrow();
  });
});

describe("selectPluginFiles", () => {
  const tree = [
    { path: "p/servers/db.js", type: "blob" as const },
    { path: "p/scripts/run.sh", type: "blob" as const },
    { path: "p/servers", type: "tree" as const },
    { path: "p/skills/foo/SKILL.md", type: "blob" as const },
    { path: "p/node_modules/dep/index.js", type: "blob" as const },
    { path: "other/x.js", type: "blob" as const },
  ];
  it("keeps plugin blobs, drops skills/, node_modules/, trees and out-of-prefix", () => {
    expect(selectPluginFiles(tree, "p/", { maxFiles: 50 })).toEqual(["p/servers/db.js", "p/scripts/run.sh"]);
  });
  it("respects the file count cap", () => {
    expect(selectPluginFiles(tree, "p/", { maxFiles: 1 })).toEqual(["p/servers/db.js"]);
  });
});
