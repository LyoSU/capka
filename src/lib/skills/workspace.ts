import { listFiles, downloadFile } from "@/lib/sandbox/client";
import { parseSkillMarkdown } from "./parse";
import { sanitizeBundlePath } from "./paths";
import { ingestSkill, type IngestTarget } from "./service";
import { readSkillZip } from "./ingest-zip";

const MAX_SKILL_FILES = 50;
const SKILL_MD = /(^|\/)SKILL\.md$/;

/** A workspace path that can't be read as a skill (unsafe, missing, empty). */
export class WorkspacePathError extends Error {}

export interface WorkspaceSkill {
  parsed: ReturnType<typeof parseSkillMarkdown>;
  files: { path: string; content: string }[];
}

/** Reject anything that could try to escape the workspace. The controller already
 *  scopes reads (safeRealPath), so this is defense-in-depth plus a clearer error
 *  than a raw controller 4xx — being universal shouldn't mean cryptic bounces. */
function safePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  if (!p || p.startsWith("/") || p.split("/").includes("..")) {
    throw new WorkspacePathError('Point at a path inside the workspace (no leading "/", no "..").');
  }
  return p;
}

/** Turn a flat file list + a byte reader into skills: every `SKILL.md` (at root or
 *  under any dir) is one skill whose bundle is the sibling files under its
 *  directory. Uniform across a single file, one skill dir, and a repo-shaped
 *  `skills/<name>/` tree — the model never has to know which shape it pointed at. */
async function collect(
  files: string[],
  read: (path: string) => Promise<string | null>,
  mds: string[],
  only?: Set<string>,
): Promise<WorkspaceSkill[]> {
  const out: WorkspaceSkill[] = [];
  for (const mdPath of mds) {
    const body = await read(mdPath);
    if (!body) continue;
    let parsed: ReturnType<typeof parseSkillMarkdown>;
    try { parsed = parseSkillMarkdown(body); } catch { continue; }
    if (!parsed.name || (only && !only.has(parsed.name))) continue;
    const dir = mdPath.replace(/SKILL\.md$/, ""); // keeps trailing "/", or "" at root
    const bundle: { path: string; content: string }[] = [];
    const sibs = files
      .filter((p) => p !== mdPath && (dir === "" ? !p.includes("/") : p.startsWith(dir)))
      .slice(0, MAX_SKILL_FILES);
    for (const s of sibs) {
      const safe = sanitizeBundlePath(s.slice(dir.length));
      if (!safe || safe === "SKILL.md") continue;
      const content = await read(s);
      if (content == null) continue;
      bundle.push({ path: safe, content: Buffer.from(content, "utf8").toString("base64") });
    }
    out.push({ parsed, files: bundle });
  }
  return out;
}

/** Read one-or-many skills from a workspace path WITHOUT touching the DB. Handles
 *  a `.zip` (unzipped in-process, bomb-guarded), a single `SKILL.md`, one skill
 *  directory, or a repo-shaped tree. Shared by preview + ingest so they agree. */
async function readWorkspacePath(
  sessionKey: string,
  userId: string,
  path: string,
  only?: string[],
): Promise<WorkspaceSkill[]> {
  if (!sessionKey) throw new WorkspacePathError("No active workspace to read the skill from.");
  const p = safePath(path);
  const onlySet = only?.length ? new Set(only) : undefined;

  // Archive: pull the bytes and unzip server-side.
  if (/\.zip$/i.test(p)) {
    const res = await downloadFile(sessionKey, p, userId);
    const { parsed, files } = readSkillZip(Buffer.from(await res.arrayBuffer()));
    return onlySet && !onlySet.has(parsed.name) ? [] : [{ parsed, files }];
  }

  // A specific SKILL.md → list its directory (for the bundle) but ingest only that
  // one skill. A directory → collect every skill under it.
  const isFile = SKILL_MD.test(p);
  const root = isFile ? p.replace(/\/?SKILL\.md$/, "") || "." : p;
  const { entries, error } = await listFiles(sessionKey, root, userId, 6);
  if (error) throw new WorkspacePathError(`Couldn't read "${path}" in the workspace: ${error}`);
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.path);
  const mds = isFile ? files.filter((f) => f === p) : files.filter((f) => SKILL_MD.test(f));
  const read = (fp: string) => downloadFile(sessionKey, fp, userId).then((r) => r.text()).catch(() => null);
  return collect(files, read, mds, onlySet);
}

/** List the skill name(s) a workspace path would install, WITHOUT ingesting — for
 *  the confirm preview / a dry run. */
export async function discoverWorkspaceSkills(
  sessionKey: string,
  userId: string,
  path: string,
  only?: string[],
): Promise<string[]> {
  return (await readWorkspacePath(sessionKey, userId, path, only)).map((s) => s.parsed.name);
}

/** Ingest one-or-many skills from a workspace path (a `SKILL.md`, a skill dir, a
 *  repo-shaped tree, or a `.zip`) into `target`. Reads the bytes server-side, so
 *  it costs the model nothing beyond the path string. Returns the ingested names. */
export async function ingestWorkspaceSkills(opts: {
  sessionKey: string;
  userId: string;
  path: string;
  target: IngestTarget;
  only?: string[];
}): Promise<string[]> {
  const skills = await readWorkspacePath(opts.sessionKey, opts.userId, opts.path, opts.only);
  if (!skills.length) throw new WorkspacePathError("No SKILL.md found at that path in the workspace.");
  for (const s of skills) await ingestSkill(s.parsed, s.files, opts.target);
  return skills.map((s) => s.parsed.name);
}
