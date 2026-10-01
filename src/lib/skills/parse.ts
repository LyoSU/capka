import matter from "gray-matter";
import { ParsedSkill, SkillParseError } from "./types";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
// The YAML parse is synchronous on the one process that also serves every chat,
// and gray-matter's own comment-stripping regex is quadratic in blank lines (60 KB
// of them block it for about 2 s). Real frontmatter is a name and a description;
// bound the block before handing it to the parser at all.
const MAX_FRONTMATTER = 8 * 1024;

// gray-matter picks its engine from the opening line, and `---js` selects one that
// evals the block in this process. The language check in parseSkillMarkdown refuses
// it first; this keeps the engine inert should anything get past. Passing options at
// all also keeps gray-matter's module-level cache, which never evicts, out of it.
const MATTER_OPTS = {
  engines: {
    javascript: () => {
      throw new SkillParseError("SKILL.md frontmatter must be YAML");
    },
  },
  // Nothing here uses the excerpt; without a function gray-matter reads
  // `excerpt_separator` out of the parsed data and stringifies it.
  excerpt: () => "",
  // Passed through to js-yaml. Anchors and aliases share nodes, and js-yaml joins an
  // aliased array used as a mapping key into one string while it parses, so a block
  // under the byte cap could still build a huge value. Real SKILL.md frontmatter
  // never needs them: refuse the first anchor, before any alias can use it. Fails
  // closed if a js-yaml upgrade ever renames the map.
  listener: (_event: string, state: { anchorMap?: object }) => {
    if (!state.anchorMap || Object.keys(state.anchorMap).length) {
      throw new SkillParseError("SKILL.md frontmatter can't use YAML anchors or aliases");
    }
  },
};

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
  const opening = /^﻿?---([^\r\n]*)/.exec(raw);
  if (opening) {
    // gray-matter reads the rest of the opening line as the block's language; a
    // fourth dash means the file has no frontmatter at all.
    const lang = opening[1].trim().toLowerCase();
    if (lang && !lang.startsWith("-") && lang !== "yaml" && lang !== "yml") {
      throw new SkillParseError("SKILL.md frontmatter must be YAML");
    }
    // gray-matter takes the whole file as frontmatter when the block never closes.
    const end = raw.indexOf("\n---");
    if ((end === -1 ? raw.length : end) > MAX_FRONTMATTER) {
      throw new SkillParseError(`SKILL.md frontmatter exceeds ${MAX_FRONTMATTER / 1024} KB`);
    }
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    try {
      parsed = matter(raw, MATTER_OPTS);
    } catch (e) {
      // Only a YAML syntax error is worth the colon-quoting retry.
      if ((e as Error)?.name !== "YAMLException") throw e;
      parsed = matter(sanitizeFrontmatter(raw), MATTER_OPTS);
    }
  } catch (e) {
    if (e instanceof SkillParseError) throw e;
    // Callers show a SkillParseError as a calm refusal; anything else would surface raw.
    const reason = (e as Error)?.name === "YAMLException" ? `: ${String((e as Error).message).split("\n")[0]}` : "";
    throw new SkillParseError(`SKILL.md frontmatter is not valid YAML${reason}`);
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
