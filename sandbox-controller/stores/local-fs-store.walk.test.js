import { describe, it, expect, vi } from "vitest";
import { rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// A queued subdirectory must be able to change between the moment the walk enqueues
// it and the moment it dequeues it — that window is what a sandbox process races.
// Hooking `stat` lets the test mutate the tree at exactly that point instead of hoping
// an unsynchronised `rm` lands there. Its own file: the module mock is file-wide.
const hook = vi.hoisted(() => ({ onStat: null, onReaddir: null, onRead: null }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    // The content hash streams the file; a hook here fails that read alone.
    createReadStream: (p, o) => hook.onRead?.(String(p)) ?? orig.createReadStream(p, o),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    stat: async (p, o) => {
      if (hook.onStat) await hook.onStat(String(p));
      return orig.stat(p, o);
    },
    readdir: async (p, o) => {
      if (hook.onReaddir) await hook.onReaddir(String(p));
      return orig.readdir(p, o);
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

      const { entries, truncated } = await store.list("u1", "s1", ".", 3, 100);
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("b/y.txt");
      expect(paths.some((p) => p.startsWith("a/"))).toBe(false);
      expect(truncated).toBe(false); // gone from the workspace: an honest omission
    } finally {
      hook.onStat = null;
      await rm(dataRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  // Folder sync reads a synced path the listing omits as deleted on the server and
  // deletes the person's local copy. A directory that exists but failed to read must
  // therefore make the listing incomplete, not quietly empty.
  const fail = (code) => Object.assign(new Error(code), { code });
  const tree = async () => {
    const dataRoot = join(TMP, `ws-err-${Math.random().toString(36).slice(2)}`);
    const store = new LocalFsStore({ dataRoot, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
    const { wsHostPath } = await store.ensure("u1", "s1");
    await mkdir(join(wsHostPath, "a"));
    await writeFile(join(wsHostPath, "a", "x.txt"), "x");
    await writeFile(join(wsHostPath, "b.txt"), "b");
    return { store, dataRoot };
  };

  it.each([
    ["a queued subdirectory", "/a", 3],
    ["the requested directory itself", "/sandbox", 1],
  ])("flags the listing incomplete when %s cannot be read", async (_, suffix, depth) => {
    const { store, dataRoot } = await tree();
    try {
      hook.onReaddir = async (p) => { if (p.endsWith(suffix)) throw fail("EACCES"); };
      expect((await store.list("u1", "s1", ".", depth, 100)).truncated).toBe(true);
      hook.onReaddir = async (p) => { if (p.endsWith(suffix)) throw fail("ENOENT"); };
      expect((await store.list("u1", "s1", ".", depth, 100)).truncated).toBe(false);
    } finally {
      hook.onReaddir = null;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("flags the listing incomplete when a file's content cannot be hashed", async () => {
    const { store, dataRoot } = await tree();
    try {
      // A stream that fails as an unreadable file's does, once it is read.
      const failing = (code) => new Readable({ read() { this.destroy(fail(code)); } });
      hook.onRead = (p) => (p.endsWith("/b.txt") ? failing("EACCES") : undefined);
      const unread = await store.list("u1", "s1", ".", 3, 100, { withHash: true });
      expect(unread.truncated).toBe(true);
      expect(unread.entries.find((e) => e.path === "a/x.txt")?.hash).toMatch(/^[0-9a-f]{64}$/);
      // Gone between its stat and its read: an honest omission, not a gap.
      hook.onRead = (p) => (p.endsWith("/b.txt") ? failing("ENOENT") : undefined);
      const gone = await store.list("u1", "s1", ".", 3, 100, { withHash: true });
      expect(gone.truncated).toBe(false);
      expect(gone.entries.map((e) => e.path)).not.toContain("b.txt");
    } finally {
      hook.onRead = null;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  // A folder that is not there lists as empty, and an empty listing against a stored
  // manifest reads as "every file was deleted on the server". The flag tells them apart.
  it("reports a requested directory that does not exist as missing, not as empty", async () => {
    const { store, dataRoot } = await tree();
    try {
      expect(await store.list("u1", "s1", "gone", 20, 100, { withHash: true })).toEqual({ entries: [], truncated: false, missing: true });
      expect((await store.list("u1", "s1", "a", 20, 100)).missing).toBe(false);
      // A file where the directory should be is no directory either.
      expect((await store.list("u1", "s1", "b.txt", 20, 100)).missing).toBe(true);
      // The whole workspace gone (the idle-workspace reaper removed it).
      await rm(join(dataRoot, "u1"), { recursive: true, force: true });
      expect((await store.list("u1", "s1", "a", 20, 100)).missing).toBe(true);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("flags the listing incomplete when an entry's metadata cannot be read", async () => {
    const { store, dataRoot } = await tree();
    try {
      hook.onStat = async (p) => { if (p.endsWith("/b.txt")) throw fail("EIO"); };
      const { entries, truncated } = await store.list("u1", "s1", ".", 3, 100);
      expect(entries.map((e) => e.path)).toContain("a/x.txt");
      expect(truncated).toBe(true);
    } finally {
      hook.onStat = null;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
