/**
 * How the picker lays a brand's models out: which order they come in, and
 * which rows are really one model in several snapshots.
 *
 * Everything here is best-effort. A name the parser does not understand
 * simply sorts alphabetically; rows fold only on an exact title match within
 * one connection; a variant's label is always something that tells it apart
 * from its head. Nothing depends on a provider following any naming scheme.
 */

export interface ModelLike {
  id: string;
  name: string;
  featured?: boolean;
  configId?: string | null;
}

export interface ModelRow<T extends ModelLike> {
  /** The row itself — the undated alias when the model has snapshots. */
  model: T;
  /** Same title, other ids: dated snapshots, `:thinking` twins, `@001` pins. */
  variants: { model: T; label: string }[];
}

// Flagship → light. Unknown words sit in the middle so they neither jump the
// queue nor sink; a title with several tier words takes the lightest.
const TIER_RANK: Record<string, number> = {
  ultra: 0, opus: 0, pro: 0, large: 0, max: 0,
  sonnet: 1, flash: 1, medium: 1, turbo: 1, plus: 1,
  haiku: 2, lite: 2, mini: 2, nano: 2, small: 2, tiny: 3,
};

interface Parsed {
  family: string;
  version: number[];
  tier: number;
  size: number;
}

function parse(name: string): Parsed {
  const tokens = name.trim().split(/\s+/);
  let first = tokens[0]?.toLowerCase() ?? "";
  // "o3", "o4" — letters fused to a version. Split so the family is "o".
  const fused = /^([a-z]+)(\d[\d.]*[a-z]?)$/.exec(first);
  if (fused) { first = fused[1]; tokens.splice(1, 0, fused[2]); }

  let version: number[] = [];
  let tier = 1;
  let size = 0;
  let sawTier = false;
  for (const raw of tokens.slice(1)) {
    const tok = raw.toLowerCase();
    const ver = /^(\d+(?:\.\d+)*)([a-z])?$/.exec(tok);
    if (ver && version.length === 0) {
      version = ver[1].split(".").map(Number);
      if (ver[2]) version.push(0.5); // "4o" sits between 4 and 4.1
      continue;
    }
    const sz = /^(\d+)b$/.exec(tok);
    if (sz) { size = Math.max(size, Number(sz[1])); continue; }
    if (tok in TIER_RANK) { tier = sawTier ? Math.max(tier, TIER_RANK[tok]) : TIER_RANK[tok]; sawTier = true; }
  }
  return { family: first, version, tier, size };
}

// Descending, elementwise; a missing element loses to any present one so
// "4.1" > "4o" > "4".
function compareVersionDesc(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1;
    if (x !== y) return y - x;
  }
  return 0;
}

const slug = (id: string) => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id);

/** What sets a variant apart from its head: the id tail past the head's own
 *  slug ("2024-08-06", "thinking", "001"), or the whole slug when unrelated. */
export function variantLabel(headId: string, id: string): string {
  const h = slug(headId), v = slug(id);
  if (v.length > h.length && v.startsWith(h) && /[-_:.@]/.test(v[h.length])) return v.slice(h.length + 1);
  return v;
}

export function arrangeModels<T extends ModelLike>(list: T[]): ModelRow<T>[] {
  const parsed = new Map<T, Parsed>();
  for (const m of list) parsed.set(m, parse(m.name));

  const sorted = [...list].sort((a, b) => {
    const pa = parsed.get(a)!, pb = parsed.get(b)!;
    return (
      Number(!!b.featured) - Number(!!a.featured) ||
      pa.family.localeCompare(pb.family) ||
      compareVersionDesc(pa.version, pb.version) ||
      pa.tier - pb.tier ||
      pb.size - pa.size ||
      a.name.localeCompare(b.name) ||
      // Same title: the shortest id is the alias, and it heads the fold.
      a.id.length - b.id.length ||
      a.id.localeCompare(b.id)
    );
  });

  const rows: ModelRow<T>[] = [];
  const byTitle = new Map<string, ModelRow<T>>();
  for (const model of sorted) {
    const key = `${model.configId ?? ""} ${model.name}`;
    const head = byTitle.get(key);
    if (head) {
      head.variants.push({ model, label: variantLabel(head.model.id, model.id) });
    } else {
      const row = { model, variants: [] };
      byTitle.set(key, row);
      rows.push(row);
    }
  }
  return rows;
}
