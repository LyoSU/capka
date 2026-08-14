import { InvalidToolInputError } from "ai";
import { log } from "@/lib/log";

/**
 * The first complete JSON value in `text`, or null.
 *
 * Written out rather than leaning on `JSON.parse` alone because the input this exists for
 * PARSES FINE up to a point and then keeps going: several objects emitted back to back with
 * nothing between them. `JSON.parse` refuses the whole string ("Unexpected non-whitespace
 * character after JSON at position N") and takes the valid prefix down with it.
 *
 * Depth counting has to skip anything inside a string, or a `{` in a path (`"a{b"`) or an
 * escaped quote (`"say \""`) closes the object early and produces a confidently wrong parse.
 */
export function firstJsonValue(text: string): { value: unknown; end: number } | null {
  const start = text.search(/[^\s]/);
  if (start === -1 || (text[start] !== "{" && text[start] !== "[")) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return { value: JSON.parse(slice), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Salvage a tool call whose arguments are several JSON objects run together.
 *
 * Models occasionally emit one tool call carrying what they meant as three:
 * `{"path":"sitemap.xml"}{"path":"robots.txt"}{"path":"llms.txt"}`. Nothing downstream can
 * read that, so the call fails on a parser message ("Unexpected non-whitespace character
 * after JSON at position 63") that says nothing about what to do differently — and the turn
 * spends a step learning it.
 *
 * The repair takes the FIRST object and drops the rest, which is the reading that matches
 * what the model was doing: those were sequential calls, and it gets the first one's result
 * and asks for the next. Deliberately narrow — the trailing text must ITSELF be complete
 * JSON values, so this only fires on a run-together call and never on arguments that are
 * merely malformed, where a guess would be a fabricated request.
 */
export function repairConcatenatedInput(input: string): string | null {
  const first = firstJsonValue(input);
  if (!first || typeof first.value !== "object" || first.value === null) return null;
  let rest = input.slice(first.end).trim();
  if (!rest) return null; // Parsed clean and used everything: not this failure mode.
  while (rest) {
    const next = firstJsonValue(rest);
    if (!next) return null;
    rest = rest.slice(next.end).trim();
  }
  return JSON.stringify(first.value);
}

/**
 * `experimental_repairToolCall` for the turn loop.
 *
 * Only `InvalidToolInputError` is in scope: a call for a tool that does not exist is the
 * model asking for something absent, and inventing a different call to answer it is a
 * different action than the one it requested. Returning null re-raises the original error,
 * which the model then sees and can correct on its own.
 */
export async function repairToolCall(
  { toolCall, error }: { toolCall: { toolName: string; input: string; [k: string]: unknown }; error: unknown },
) {
  if (!InvalidToolInputError.isInstance(error)) return null;
  const repaired = repairConcatenatedInput(toolCall.input);
  if (!repaired) return null;
  log.warn("tool call arguments arrived run together; applying the first", {
    tool: toolCall.toolName, chars: toolCall.input.length,
  });
  return { ...toolCall, input: repaired };
}
