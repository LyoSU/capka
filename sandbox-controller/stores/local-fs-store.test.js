import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
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
