/**
 * Strip NUL (`\u0000`) bytes from every string inside a JSON-serializable value.
 *
 * Why: Postgres `jsonb` (and `pg_notify` payloads) store text, and PostgreSQL
 * text cannot contain a NUL byte — even the valid JSON escape `\u0000` is
 * rejected with "unsupported Unicode escape sequence". A tool that returns raw
 * binary (e.g. a PNG's "PNG\r\n..." header) as its `output.content` would
 * otherwise make the `UPDATE messages ... set metadata = $2` write throw and the
 * assistant message never persist.
 *
 * This runs at the single trust boundary where external tool output enters our
 * data model (the runner's `tool-result` event), so everything downstream —
 * the streamed snapshot, the final DB write, the realtime publish — can rely on
 * `parts` never carrying a NUL without re-checking. Only `\u0000` is removed:
 * other control characters (`\u001a`, `\n`, ...) are valid in `jsonb` and may be
 * legitimate file content, so stripping them too would corrupt good data.
 *
 * Note: this keeps a half-binary blob alive as mangled text — enough to stop the
 * crash, not a substitute for tools returning proper image/file references.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("\u0000") ? value.replaceAll("\u0000", "") : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNul) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNul(v);
    return out as T;
  }
  return value;
}
