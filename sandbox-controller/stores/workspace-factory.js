import { LocalFsStore } from "./local-fs-store.js";

/** Pick a WorkspaceStore implementation by kind (WORKSPACE_STORE env).
 *  Stage 1: only "local". Stage 2 will add "s3". */
export function makeWorkspaceStore({ kind = "local", dataRoot, hostDataRoot, uid, gid }) {
  switch (kind) {
    case "local":
      return new LocalFsStore({ dataRoot, hostDataRoot, uid, gid });
    default:
      throw new Error(`unknown WORKSPACE_STORE: ${kind}`);
  }
}
