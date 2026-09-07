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

/** A losing version to keep beside the winner. `source` is the side the losing
 *  bytes still live on (read them there), `keepAs` is the path to keep them under —
 *  the *proposed* name: only the executor can see whether something already sits
 *  there, so it steps the counter (`resolveConflictName` in bridge.ts) before
 *  writing. The directory is what the plan depends on, and that never changes. */
export type ConflictCopy = { path: string; keepAs: string; source: "local" | "remote" };

export type SyncPlan = {
  upload: string[]; // local → server
  download: string[]; // server → local
  deleteRemote: string[]; // deleted locally since base
  deleteLocal: string[]; // deleted on server since base
  conflicts: { path: string; winner: "local" | "remote" }[]; // both changed; last-writer-wins by mtime
  conflictCopies: ConflictCopy[]; // the losing versions, preserved before the winner overwrites
};

/** The name a losing version is kept under: "report.docx" → "report.conflict-2026-09-07-143200.docx".
 *  Dated so the person can tell at a glance which copy is which; extension preserved
 *  so it still opens. `nth` above 1 appends "-2", "-3" … for the case the dated name
 *  is already taken — the stamp used to stop at the minute, so a second conflict on
 *  the same file inside that minute produced the SAME name and the write truncated the
 *  version the first one had just saved. Seconds narrow that window; the counter (see
 *  `freeConflictName`) closes it. Pure. */
export function conflictName(path: string, at: Date, nth = 1): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1); // "" when there is no slash
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  // dot at 0 is a dotfile (".env"), not an extension — keep the whole name as the stem.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${dir}${stem}.conflict-${stamp}${nth > 1 ? `-${nth}` : ""}${ext}`;
}


/** Same file content? Compare by hash when both sides carry one (the reliable
 *  signal); otherwise fall back to size (the server manifest is mtime+size only). */
function sameContent(a: Entry, b: Entry): boolean {
  return a.hash != null && b.hash != null ? a.hash === b.hash : a.size === b.size;
}

/** Changed since base = no base entry (new), or content differs from it. */
function changed(entry: Entry, base: Entry | undefined): boolean {
  return !base || !sameContent(entry, base);
}

/** `excluded` are paths we deliberately did NOT track on one/both sides (oversized
 *  now, though they may sit in base or the other manifest). Their absence from a
 *  manifest is NOT a deletion — it's "we chose not to look" — so the planner leaves
 *  them completely alone (no delete that drops a real copy, no download that would
 *  clobber the user's larger local file). Without this, a file that grows past the
 *  cap on one side gets deleted on the other. */
export function planSync(local: Manifest, remote: Manifest, base: Manifest | null, excluded?: Set<string>, now: number = Date.now()): SyncPlan {
  const plan: SyncPlan = { upload: [], download: [], deleteRemote: [], deleteLocal: [], conflicts: [], conflictCopies: [] };
  const stampedAt = new Date(now);
  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base ?? {})]);

  for (const path of paths) {
    if (excluded?.has(path)) continue; // skipped on some side → never infer a delete
    const l = local[path];
    const r = remote[path];
    const b = base?.[path];

    if (l && r) {
      if (sameContent(l, r)) continue; // already in sync
      const lc = changed(l, b);
      const rc = changed(r, b);
      if (lc && rc) {
        // Both sides edited the same file. The newer mtime decides which version stays
        // THE file — but the two mtimes come from two different clocks (the computer's
        // and the sandbox host's), so the decision can be wrong. Never let it destroy
        // the other version: the loser is kept beside the winner under a dated name.
        const winner = l.mtime >= r.mtime ? "local" : "remote";
        plan.conflicts.push({ path, winner });
        plan.conflictCopies.push({ path, keepAs: conflictName(path, stampedAt), source: winner === "local" ? "remote" : "local" });
      }
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
  plan.conflictCopies.sort((a, b) => a.path.localeCompare(b.path));
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
 *  has no server-side mkdir path, so it is intentionally a no-op.
 *
 *  `keepPaths` are the files this same sync is about to write (uploads, downloads,
 *  conflict copies). Every directory holding one of them survives on BOTH sides: the
 *  assistant writing a new file into a directory the person deleted on their computer
 *  would otherwise have the file downloaded and its directory deleted in the same run,
 *  and the copy erased again on the next one. Pure. */
export function planDirs(local: string[], remote: string[], base: string[] | null, keepPaths?: string[]): DirPlan {
  const L = new Set(local), R = new Set(remote), B = new Set(base ?? []);
  // Every ancestor directory of a file this sync will write.
  const keep = new Set<string>();
  for (const p of keepPaths ?? []) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) keep.add(parts.slice(0, i).join("/"));
  }
  const plan: DirPlan = { createLocal: [], deleteRemote: [], deleteLocal: [] };
  for (const d of new Set([...L, ...R, ...B])) {
    const l = L.has(d), r = R.has(d), b = B.has(d);
    if (keep.has(d)) { if (r && !l && !b) plan.createLocal.push(d); continue; } // holds a file being written — never delete
    if (r && !l) (b ? plan.deleteRemote : plan.createLocal).push(d); // gone on PC: delete if known, else mirror down
    else if (l && !r && b) plan.deleteLocal.push(d); // gone on server since base → propagate to PC
  }
  // Ascending sort = parent before child: safe for recursive rmdir/mkdir either way.
  for (const k of ["createLocal", "deleteRemote", "deleteLocal"] as const) plan[k].sort();
  return plan;
}
