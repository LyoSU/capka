import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sanitize, safeJoin, safeRealPath } from "./path-safety.js";

describe("sanitize", () => {
  it("keeps safe id characters", () => {
    expect(sanitize("abc-123_XYZ")).toBe("abc-123_XYZ");
  });

  it("strips path/traversal and shell/docker-hostile characters", () => {
    expect(sanitize("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitize("a/b/c")).toBe("abc");
    expect(sanitize("evil; rm -rf /")).toBe("evilrm-rf");
    expect(sanitize("..")).toBe("");
    expect(sanitize("a.b")).toBe("ab");
  });

  it("caps length to 64 and coerces non-strings", () => {
    expect(sanitize("x".repeat(100))).toHaveLength(64);
    expect(sanitize(12345)).toBe("12345");
    expect(sanitize(null)).toBe("null".replace(/[^a-zA-Z0-9_-]/g, ""));
  });
});

describe("safeJoin", () => {
  const base = "/data/ws";

  it("joins a normal relative path under base", () => {
    expect(safeJoin(base, "sub/file.txt")).toBe("/data/ws/sub/file.txt");
  });

  it("allows base itself (empty path)", () => {
    expect(safeJoin(base, "")).toBe(base);
  });

  it("blocks ../ traversal out of base", () => {
    expect(() => safeJoin(base, "../secret")).toThrow(/traversal/i);
    expect(() => safeJoin(base, "sub/../../secret")).toThrow(/traversal/i);
  });

  it("blocks an absolute path that escapes base", () => {
    expect(() => safeJoin(base, "/etc/passwd")).toThrow(/traversal/i);
  });

  it("does NOT confuse a sibling sharing the name prefix with being inside base", () => {
    // /data/ws-evil starts with "/data/ws" as a string but is NOT inside it.
    expect(() => safeJoin(base, "../ws-evil/x")).toThrow(/traversal/i);
  });
});

describe("safeRealPath", () => {
  let base;
  let root;

  beforeAll(async () => {
    // Canonicalize root: on macOS tmpdir() (/var/...) is itself a symlink to
    // /private/var/..., which would otherwise trip the symlink-containment check.
    // In production DATA_ROOT is already a real path, so this only normalizes the
    // test fixture, not the behaviour under test.
    root = await realpath(await mkdtemp(join(tmpdir(), "unclaw-pathsafety-")));
    base = resolve(root, "ws");
    await mkdir(join(base, "sub"), { recursive: true });
    await writeFile(join(base, "sub", "ok.txt"), "hi");
    // An "outside" directory and a symlink inside the workspace pointing to it.
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "secret.txt"), "leak");
    await symlink(join(root, "outside"), join(base, "escape"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the real path for a legitimate file inside base", async () => {
    const p = await safeRealPath(base, "sub/ok.txt");
    expect(p).toBe(resolve(base, "sub/ok.txt"));
  });

  it("blocks a symlink that escapes base (the key boundary property)", async () => {
    await expect(safeRealPath(base, "escape/secret.txt")).rejects.toThrow(/symlink escape/i);
  });

  it("returns the joined path for a not-yet-existing write target (ENOENT)", async () => {
    const p = await safeRealPath(base, "sub/new-file.txt");
    expect(p).toBe(resolve(base, "sub/new-file.txt"));
  });

  it("still blocks lexical traversal before touching the filesystem", async () => {
    await expect(safeRealPath(base, "../outside/secret.txt")).rejects.toThrow(/traversal/i);
  });
});
