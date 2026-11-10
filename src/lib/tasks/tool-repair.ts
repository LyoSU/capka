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

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_DEPTH = 6;

/** A value of JSON-schema `type`, after coercion — what makes wrapping a bare value safe. */
const fits = (type: unknown, v: unknown) =>
  type === "integer" ? Number.isSafeInteger(v)
  : type === "number" ? typeof v === "number" && Number.isFinite(v)
  : type === "object" ? isObj(v)
  : type === "array" ? Array.isArray(v)
  : (type === "string" || type === "boolean") && typeof v === type;

/**
 * Bring `value` in line with `schema` where the schema leaves exactly one reading.
 *
 * Models routinely send `"20"` for a number, `"true"` for a boolean, a stringified object for
 * an object, or `null` for an omitted optional — each costs a failed step to learn. Every
 * branch here fires only on a schema that unambiguously asks for the other shape; anything
 * with two live readings (a union of several non-null types, an enum, a const, a `$ref`) is
 * returned untouched, because a guess there is a fabricated request. `$ref` is not resolved:
 * zod's output inlines everything (no `$defs`), so only a third-party MCP schema carries one,
 * and leaving that call to fail as before is the safe side.
 */
export function coerceToSchema(value: unknown, schema: unknown, depth = 0): unknown {
  if (!isObj(schema) || depth > MAX_DEPTH || "enum" in schema || "const" in schema) return value;
  let type = schema.type;
  if (Array.isArray(type)) {
    if (value === null && type.includes("null")) return value;
    const rest = type.filter((t) => t !== "null");
    if (rest.length !== 1) return value;
    type = rest[0];
  }
  if (type === undefined) {
    // `T | null` from zod's .nullable(): one non-null branch is the only reading.
    const branches = (schema.anyOf ?? schema.oneOf) as unknown;
    if (value === null || !Array.isArray(branches) || (schema.anyOf && schema.oneOf)) return value;
    const live = branches.filter((b) => !isObj(b) || b.type !== "null");
    return live.length === 1 ? coerceToSchema(value, live[0], depth + 1) : value;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "string" || !value.trim()) return value;
    const n = Number(value);
    return fits(type, n) ? n : value;
  }
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  if (type === "object") {
    const obj = typeof value === "string" ? parseJson(value) : value;
    if (!isObj(obj)) return value;
    const props = isObj(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const patterned = isObj(schema.patternProperties);
    const composed = !!(schema.allOf || schema.anyOf || schema.oneOf);
    const out: Schema = {};
    for (const [key, v] of Object.entries(obj)) {
      const declared = Object.hasOwn(props, key);
      const prop = declared ? props[key] : patterned ? undefined : schema.additionalProperties;
      if (!declared && schema.additionalProperties === false && !patterned && !composed) continue;
      // Only a bare single-type property provably rejects null and `{}`; a nullable, enum or
      // composed one may accept them, so those keep the key.
      const plain = isObj(prop) && typeof prop.type === "string" && prop.type !== "null"
        && !["anyOf", "oneOf", "allOf", "enum", "const", "$ref", "nullable"].some((k) => k in prop);
      const placeholder = isObj(v) && !Object.keys(v).length && isObj(prop) && prop.type !== "object";
      if (declared && !required.includes(key) && plain && (v === null || placeholder)) continue;
      out[key] = coerceToSchema(v, prop, depth + 1);
    }
    return out;
  }
  if (type === "array") {
    const arr = typeof value === "string" ? parseJson(value) : value;
    const items = schema.items;
    if (Array.isArray(arr)) {
      return arr.map((v) => coerceToSchema(v, items, depth + 1));
    }
    // A bare value where a list was meant: wrap it, but only if it really is the item type.
    if (!isObj(items) || Array.isArray(items)) return value;
    const item = coerceToSchema(value, items, depth + 1);
    return fits(items.type, item) ? [item] : value;
  }
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `experimental_repairToolCall` for the turn loop.
 *
 * Only `InvalidToolInputError` is in scope: a call for a tool that does not exist is the
 * model asking for something absent, and inventing a different call to answer it is a
 * different action than the one it requested. Returning null re-raises the original error,
 * which the model then sees and can correct on its own — also when the repair changed
 * nothing, so a call the schema still rejects keeps its original, accurate message.
 */
export async function repairToolCall(
  { toolCall, error, inputSchema }: {
    toolCall: { toolName: string; input: string; [k: string]: unknown };
    error: unknown;
    inputSchema?: (o: { toolName: string }) => PromiseLike<unknown>;
  },
) {
  if (!InvalidToolInputError.isInstance(error)) return null;
  const joined = repairConcatenatedInput(toolCall.input);
  const parsed = parseJson(joined ?? toolCall.input);
  if (!isObj(parsed)) return null;
  let fixed: unknown = parsed;
  try {
    const schema = inputSchema ? await inputSchema({ toolName: toolCall.toolName }) : undefined;
    if (isObj(schema) && schema.type === "object") fixed = coerceToSchema(parsed, schema);
  } catch {
    // No schema to go by: the concatenation repair, if any, still stands.
  }
  const input = JSON.stringify(fixed);
  if (!joined && input === JSON.stringify(parsed)) return null;
  log.warn("tool call arguments repaired", {
    tool: toolCall.toolName, chars: toolCall.input.length, joined: !!joined,
  });
  return { ...toolCall, input };
}
