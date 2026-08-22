/**
 * Reading a numeric knob from the environment with the rule stated at the call site
 * instead of implied by `||`.
 *
 * `Number(process.env.X) || fallback` reads as if it validated, and does not: it
 * rejects only the FALSY results. A typo yields the default, but a NEGATIVE value is
 * truthy, so it survives and runs. `TASK_TIMEOUT_MINUTES=-1` made the task abort
 * timer fire at ~1ms (setTimeout clamps a negative delay to 0) while the wrap-up
 * fraction `1 - (deadlineAt - now) / MAX_TASK_MS` divided a negative by a negative
 * and descended AWAY from its threshold — a brake that could never arm, on turns
 * that were already dead. The same shape swallows a deliberate `0`.
 *
 * Two functions rather than one, because whether `0` is a policy or a mistake is a
 * property of the CONSUMER, not of the knob's type. A single positive-only helper
 * would silently rewrite the knobs where zero means something, which is the bug this
 * file exists to remove, reintroduced one layer down.
 *
 * The discriminator, applied per knob: zero is a policy when it selects a different
 * working behaviour (`MAX_MCP_MEDIA_BYTES=0` still delivers the media, by spilling it
 * to a file instead of inlining; `JOBS_KEEP_DIRS=0` is a retention choice), and a
 * mistake when it removes the output altogether (`JOB_LOG_CAP_MB=0` is `head -c 0` —
 * an empty log, not a smaller one).
 *
 * Both treat an unset or empty value as "not configured" so an empty string in a
 * compose file means the same thing as an absent line.
 */

/** A positive integer, or the built-in default. Zero is rejected. */
export function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A non-negative integer, or the built-in default. Zero is honoured. */
export function nonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
