import matter from "gray-matter";
import { ParsedSkill, SkillParseError } from "./types";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;

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
  return raw.replace(m[1], fixed);
}

export function parseSkillMarkdown(raw: string): ParsedSkill {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    parsed = matter(sanitizeFrontmatter(raw));
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>;
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
