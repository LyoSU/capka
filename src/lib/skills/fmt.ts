const MAX_DESC_IN_PROMPT = 500;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/**
 * Derive a one-line summary from a skill body, for skills that carry no
 * frontmatter `description`. This is the safety net for command-style skills
 * (e.g. those imported from a plugin's `commands/` dir, which converge to
 * skills but legitimately lack a description — see marketplace/install.ts):
 * without it they'd be silently dropped from the prompt and never reachable.
 *
 * Strategy: skip any leading frontmatter and code fences, then take the first
 * markdown heading text, else the first non-empty prose line. Deterministic
 * (no clock/random) so the cached prompt prefix stays byte-stable.
 */
export function deriveDescription(body: string | null | undefined): string {
  if (!body) return "";
  let text = body.trim();
  // Drop a leading YAML frontmatter block if the raw file body still carries one.
  const fm = text.match(/^---\n[\s\S]*?\n---\s*/);
  if (fm) text = text.slice(fm[0].length);

  let inFence = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("#")) {
      const heading = line.replace(/^#+\s*/, "").trim();
      if (heading) return heading;
      continue;
    }
    // First real prose line — strip common markdown emphasis/list markers.
    return line.replace(/^[-*>]\s+/, "").replace(/[*_`]/g, "").trim();
  }
  return "";
}

/**
 * Phase-1 progressive disclosure: render name + description of each skill
 * (ported from OpenCode `fmt()`). A skill with no frontmatter description falls
 * back to a summary derived from its body, so every ENABLED skill is reachable
 * by the model — never silently invisible. Returns "" when there's nothing to
 * show so the caller can skip the section entirely.
 *
 * Output is DETERMINISTIC (sorted by name, no timestamps/random) so the system
 * prompt prefix stays byte-stable across turns — required for prompt caching.
 */
export function formatAvailableSkills(
  list: { name: string; description: string | null; body?: string | null }[],
): string {
  const lines = list
    .map((s) => ({ name: s.name, summary: s.description?.trim() || deriveDescription(s.body) }))
    .filter((s) => s.summary)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- **${s.name}**: ${truncate(s.summary, MAX_DESC_IN_PROMPT)}`);
  if (lines.length === 0) return "";
  return [
    "## Available Skills",
    "When a skill below fits the request, call the `skill` tool with its name to load full instructions.",
    ...lines,
  ].join("\n");
}
