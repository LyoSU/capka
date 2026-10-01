import matter from "gray-matter";
import { ParsedSkill, SkillParseError } from "./types";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
// The YAML parse is synchronous on the one process that also serves every chat,
// and a crafted block can cost it superlinear CPU. Real frontmatter is a name and
// a description; bound the block before handing it to the parser at all.
const MAX_FRONTMATTER = 64 * 1024;
// YAML aliases share nodes, so a block under the byte cap can still expand into a
// huge value once it is stored as jsonb. Bound what the parse returns as well.
const MAX_EXPANDED = 256 * 1024;
const MAX_DEPTH = 32;

// gray-matter picks its engine from the opening line, and `---js` selects one that
// evals the block in this process. Passing options also keeps gray-matter's
// module-level cache, which never evicts, out of the picture.
const MATTER_OPTS = {
  engines: {
    javascript: () => {
      throw new SkillParseError("SKILL.md frontmatter must be YAML");
    },
  },
  // Without an excerpt function, gray-matter reads `excerpt_separator` from the
  // parsed data and stringifies it inside matter(), so an alias array there would
  // expand before assertBounded ever sees it. Nothing here uses the excerpt.
  excerpt: () => "",
};

function assertBounded(value: unknown, budget: { left: number }, depth: number): void {
  budget.left -= typeof value === "string" ? value.length + 1 : 1;
  if (budget.left < 0 || depth > MAX_DEPTH) {
    throw new SkillParseError("SKILL.md frontmatter is too large once expanded");
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) assertBounded(child, budget, depth + 1);
  }
}

/**
 * gray-matter's YAML parser is strict: an unquoted colon in a scalar value
 * (common in skill descriptions like "Use when: …") throws. OpenCode hit the
 * same bug (#8331) and wraps parsing with a sanitize-retry. We quote bare
 * scalar values that contain a colon, then re-parse.
 */
function sanitizeFrontmatter(raw: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return raw;
  const fixed = m[1]
    .split("\n")
    .map((line) => {
      const kv = line.match(/^(\s*[A-Za-z0-9_-]+:)\s+(.*)$/);
      if (!kv) return line;
      const [, key, value] = kv;
      const v = value.trim();
      if (!v || /^["'[{|>]/.test(v) || !v.includes(":")) return line;
      return `${key} "${v.replace(/"/g, '\\"')}"`;
    })
    .join("\n");
  // A replacer function: a string replacement would expand `$&` and friends in a value.
  return raw.replace(m[1], () => fixed);
}

export function parseSkillMarkdown(raw: string): ParsedSkill {
  if (/^\uFEFF?---/.test(raw)) {
    // gray-matter takes the whole file as frontmatter when the block never closes.
    const end = raw.indexOf("\n---");
    if ((end === -1 ? raw.length : end) > MAX_FRONTMATTER) {
      throw new SkillParseError(`SKILL.md frontmatter exceeds ${MAX_FRONTMATTER / 1024} KB`);
    }
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw, MATTER_OPTS);
  } catch {
    parsed = matter(sanitizeFrontmatter(raw), MATTER_OPTS);
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>;
  assertBounded(data, { left: MAX_EXPANDED }, 0);
  const name = data.name;
  if (typeof name !== "string" || !NAME_RE.test(name) || name.length > MAX_NAME) {
    throw new SkillParseError(
      `Invalid skill name "${String(name)}" — must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be ≤${MAX_NAME} chars`,
    );
  }

  let description: string | undefined;
  if (typeof data.description === "string") {
    if (data.description.length > MAX_DESC) {
      throw new SkillParseError(`Skill "${name}" description exceeds ${MAX_DESC} chars`);
    }
    description = data.description;
  }

  return { name, description, body: parsed.content.trim(), frontmatter: data };
}
