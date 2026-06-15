const MAX_DESC_IN_PROMPT = 500;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/**
 * Phase-1 progressive disclosure: render only name + description of each
 * describable skill (ported from OpenCode `fmt()`). Returns "" when there is
 * nothing to show so the caller can skip the section entirely.
 *
 * Output is DETERMINISTIC (sorted by name, no timestamps/random) so the system
 * prompt prefix stays byte-stable across turns — required for prompt caching.
 */
export function formatAvailableSkills(list: { name: string; description: string | null }[]): string {
  const described = list.filter((s) => s.description && s.description.trim());
  if (described.length === 0) return "";
  const lines = described
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- **${s.name}**: ${truncate(s.description!.trim(), MAX_DESC_IN_PROMPT)}`);
  return [
    "## Available Skills",
    "When a skill below fits the request, call the `skill` tool with its name to load full instructions.",
    ...lines,
  ].join("\n");
}
