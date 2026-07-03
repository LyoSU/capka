/**
 * Pure 3-way sync planner for PC folders (browser bridge). Given the local file
 * tree, the server tree, and the base snapshot from the last successful sync, it
 * decides what to move each way — distinguishing a genuine one-sided change from a
 * true conflict, and inferring deletes from the base (no tombstones). No browser
 * APIs here, so it is fully unit-tested; the bridge (bridge.ts) just executes the
 * returned actions. Modeled on Mutagen's base-snapshot merge.
 */

export type Entry = { mtime: number; size: number; hash?: string };
export type Manifest = Record<string, Entry>;

export type SyncPlan = {
  upload: string[]; // local → server
  download: string[]; // server → local
  deleteRemote: string[]; // deleted locally since base
  deleteLocal: string[]; // deleted on server since base
  conflicts: { path: string; winner: "local" | "remote" }[]; // both changed; last-writer-wins by mtime
};

/** Same file content? Compare by hash when both sides carry one (the reliable
 *  signal); otherwise fall back to size (the server manifest is mtime+size only). */
function sameContent(a: Entry, b: Entry): boolean {
  return a.hash != null && b.hash != null ? a.hash === b.hash : a.size === b.size;
}

/** Changed since base = no base entry (new), or content differs from it. */
function changed(entry: Entry, base: Entry | undefined): boolean {
  return !base || !sameContent(entry, base);
}

export function planSync(local: Manifest, remote: Manifest, base: Manifest | null): SyncPlan {
  const plan: SyncPlan = { upload: [], download: [], deleteRemote: [], deleteLocal: [], conflicts: [] };
  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base ?? {})]);

  for (const path of paths) {
    const l = local[path];
    const r = remote[path];
    const b = base?.[path];

    if (l && r) {
      if (sameContent(l, r)) continue; // already in sync
      const lc = changed(l, b);
      const rc = changed(r, b);
      if (lc && rc) plan.conflicts.push({ path, winner: l.mtime >= r.mtime ? "local" : "remote" });
      else if (lc) plan.upload.push(path);
      else plan.download.push(path); // only remote changed (or neither vs base but they differ — treat as remote)
    } else if (l && !r) {
      // Present locally, absent on the server: a server-side delete since base
      // (propagate: remove local) vs a brand-new local file (upload).
      if (b) plan.deleteLocal.push(path);
      else plan.upload.push(path);
    } else if (!l && r) {
      // Present on the server, absent locally: a local delete since base
      // (propagate: remove remote) vs a new remote file (download).
      if (b) plan.deleteRemote.push(path);
      else plan.download.push(path);
    }
    // else: in base only → deleted on both sides → nothing to do.
  }

  // Deterministic output (stable diffs, predictable execution order).
  for (const k of ["upload", "download", "deleteRemote", "deleteLocal"] as const) plan[k].sort();
  plan.conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

export type DirPlan = {
  createLocal: string[]; // new server dir → mkdir on the PC (mirror empty folders)
  deleteRemote: string[]; // dir removed on the PC since base → rmdir on the server
  deleteLocal: string[]; // dir removed on the server since base → rmdir on the PC
};

/** Directory 3-way merge. Directories have no content, so this is presence-based:
 *  a dir gone from one side is a *delete* only if it was in base (previously synced),
 *  otherwise it is a *new* dir on the other side. This is what stops a folder deleted
 *  on the PC from being resurrected by the blind server→PC mirror (see the bridge):
 *  in-base + gone-locally = deleteRemote, not createLocal. A brand-new empty local dir
 *  has no server-side mkdir path, so it is intentionally a no-op. Pure. */
export function planDirs(local: string[], remote: string[], base: string[] | null): DirPlan {
  const L = new Set(local), R = new Set(remote), B = new Set(base ?? []);
  const plan: DirPlan = { createLocal: [], deleteRemote: [], deleteLocal: [] };
  for (const d of new Set([...L, ...R, ...B])) {
    const l = L.has(d), r = R.has(d), b = B.has(d);
    if (r && !l) (b ? plan.deleteRemote : plan.createLocal).push(d); // gone on PC: delete if known, else mirror down
    else if (l && !r && b) plan.deleteLocal.push(d); // gone on server since base → propagate to PC
  }
  // Ascending sort = parent before child: safe for recursive rmdir/mkdir either way.
  for (const k of ["createLocal", "deleteRemote", "deleteLocal"] as const) plan[k].sort();
  return plan;
}
