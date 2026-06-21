import { describe, it, expect } from "vitest";
import { rm, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStore } from "./local-fs-store.js";
import { runWorkspaceStoreContract } from "./workspace-store.contract.js";

// Canonicalize the temp base: on macOS tmpdir() is under /var -> /private/var, and
// safeRealPath's symlink-containment check would otherwise reject every path.
// On the Linux deploy dataRoot (/data/storage) is already canonical.
const TMP = realpathSync(tmpdir());

runWorkspaceStoreContract(() => {
  const dir = join(TMP, `ws-${Math.random().toString(36).slice(2)}`);
  const store = new LocalFsStore({
    dataRoot: dir,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  });
  return { store, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
});

// Filesystem-specific hardening beyond the shared contract: a process inside the
// sandbox owns its /workspace and can plant symlinks there. A later controller-side
// write MUST NOT follow such a symlink out of the workspace (matches the multi-tenant
// untrusted-code threat model).
describe("LocalFsStore symlink containment on write", () => {
  it("refuses to write through a symlinked parent dir, leaving the outside target untouched", async () => {
    const dataRoot = join(TMP, `ws-sec-${Math.random().toString(36).slice(2)}`);
    const outside = join(TMP, `outside-${Math.random().toString(36).slice(2)}`);
    const store = new LocalFsStore({ dataRoot, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "victim.txt"), "original");
      const { wsHostPath } = await store.ensure("u1", "s1");
      // Sandbox plants `escape -> outside/` inside its own workspace.
      await symlink(outside, join(wsHostPath, "escape"));

      await expect(store.write("u1", "s1", "escape/victim.txt", Buffer.from("pwned"))).rejects.toBeTruthy();
      // The outside file was neither overwritten nor a new one created through the link.
      expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("original");
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
      await expect(store.write("u1", "s1", "escape/new.txt", Buffer.from("pwned"))).rejects.toBeTruthy();
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
