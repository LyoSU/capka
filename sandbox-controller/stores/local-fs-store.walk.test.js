import { describe, it, expect, vi } from "vitest";
import { rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A queued subdirectory must be able to change between the moment the walk enqueues
// it and the moment it dequeues it — that window is what a sandbox process races.
// Hooking `stat` lets the test mutate the tree at exactly that point instead of hoping
// an unsynchronised `rm` lands there. Its own file: the module mock is file-wide.
const hook = vi.hoisted(() => ({ onStat: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    stat: async (p, o) => {
      if (hook.onStat) await hook.onStat(String(p));
      return orig.stat(p, o);
    },
  };
});
const { LocalFsStore } = await import("./local-fs-store.js");

const TMP = realpathSync(tmpdir()); // see local-fs-store.test.js

describe("LocalFsStore.list walk", () => {
  it.each([
    ["escapes the workspace", (a, outside) => symlink(outside, a)],
    ["became a symlink loop", (a) => symlink(a, a)],
  ])("skips a queued subdirectory that %s and still lists the rest", async (_, replace) => {
    const dataRoot = join(TMP, `ws-walk-${Math.random().toString(36).slice(2)}`);
    const outside = join(TMP, `outside-walk-${Math.random().toString(36).slice(2)}`);
    const store = new LocalFsStore({ dataRoot, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "secret.txt"), "do not inspect");
      const { wsHostPath } = await store.ensure("u1", "s1");
      await mkdir(join(wsHostPath, "a"));
      await writeFile(join(wsHostPath, "a", "x.txt"), "x");
      await mkdir(join(wsHostPath, "b"));
      await writeFile(join(wsHostPath, "b", "y.txt"), "y");
      // "a" sorts first, so it is already queued when "b" is stat'ed: swap it then.
      hook.onStat = async (p) => {
        if (!p.endsWith("/b")) return;
        hook.onStat = null;
        await rm(join(wsHostPath, "a"), { recursive: true, force: true });
        await replace(join(wsHostPath, "a"), outside);
      };

      const { entries } = await store.list("u1", "s1", ".", 3, 100);
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("b/y.txt");
      expect(paths.some((p) => p.startsWith("a/"))).toBe(false);
    } finally {
      hook.onStat = null;
      await rm(dataRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
