/**
 * Extract a human-readable message string from an UNKNOWN thrown/streamed value.
 *
 * Why this exists: providers and the AI SDK surface errors in wildly different
 * shapes — a real `Error`, a bare string, a provider payload like
 * `{ message, code }`, or a nested `{ error: { message } }`. The old code did
 * `String(raw)`, which collapses any plain object to the literal
 * `"[object Object]"`. That not only shows admins garbage, it ALSO defeats
 * `classifyLLMError` (its regex rules then have no real text to match, so every
 * object-shaped error falls through to the "unknown" category).
 *
 * This is the single place that turns `unknown` into a useful string, used by
 * the task runner (`errMsg`) and the friendly-error classifier.
 */
export function errorText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Direct `{ message }` shape.
    if (typeof obj.message === "string") return obj.message;
    // Provider shape `{ error: "..." }` or `{ error: { message } }` (OpenAI /
    // OpenRouter). One level deep on purpose — no recursion, no surprises.
    const err = obj.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return (err as Record<string, unknown>).message as string;
    }
    // No human field — keep the structure (so a buried code is still matchable)
    // rather than collapsing to "[object Object]". Provider errors sometimes
    // carry circular request/response refs, so guard the stringify.
    try {
      return JSON.stringify(raw);
    } catch {
      return "[unserializable error]";
    }
  }

  // numbers, booleans, symbols, bigint…
  return String(raw);
}
