/**
 * How many lines a turn added to and removed from each file it wrote.
 *
 * The sandbox file tools report the size of what they wrote (`write_file` →
 * `lines`, `str_replace` → `added`/`removed`); this folds those results per file so
 * the artifact tile can carry a `+74 −41` the way a code review does. Messages
 * from before the tools reported sizes simply have no entry — the tile shows
 * nothing rather than a zero.
 */
export type EditStat = { added: number; removed: number };

type ToolLike = { type: string; toolName?: string; input?: unknown; output?: unknown };

/** The tools name paths relative to /workspace; the reply and `touchedFiles`
 *  may name the same file absolutely. One key for both. */
export function editKey(path: string): string {
  return path.replace(/^\/workspace\//, "").replace(/^\.\//, "");
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function editStatsFromParts(parts: ReadonlyArray<ToolLike>): Map<string, EditStat> {
  const out = new Map<string, EditStat>();
  for (const part of parts) {
    const name = part.toolName ?? (part.type.startsWith("tool-") ? part.type.slice(5) : "");
    if (name !== "write_file" && name !== "str_replace") continue;
    const output = part.output as Record<string, unknown> | undefined;
    const input = part.input as Record<string, unknown> | undefined;
    if (!output || output.success !== true) continue;
    const path = typeof output.path === "string" ? output.path : typeof input?.path === "string" ? input.path : null;
    if (!path) continue;
    const added = num(name === "write_file" ? output.lines : output.added);
    const removed = name === "write_file" ? 0 : num(output.removed);
    if (added === null || removed === null) continue;
    const key = editKey(path);
    const cur = out.get(key) ?? { added: 0, removed: 0 };
    out.set(key, { added: cur.added + added, removed: cur.removed + removed });
  }
  return out;
}

/** The lines a string spans; a trailing newline does not start another line. */
export function lineCount(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}
