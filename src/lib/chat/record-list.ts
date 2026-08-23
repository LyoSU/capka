/**
 * Recognize a tool result that is a LIST OF RECORDS, so the UI can render it as
 * one — headings, links, quiet metadata — instead of a wall of raw text.
 *
 * Two entry points, tried in order of authority, both tool-agnostic:
 *
 *  - `recordsFromValue`: the MCP-standard path. Since spec 2025-06-18 a tool
 *    SHOULD return typed output in `structuredContent`; an array of plain
 *    objects there (or as the whole output) is a record list by construction —
 *    no parsing, the server told us the shape.
 *  - `recordsFromText`: the fallback for tools that only emit formatted text.
 *    There is NO standard for that text, so the detector is purely structural:
 *    several blank-line-separated blocks, each a run of `Key: value` lines,
 *    all opening with the SAME key (the repeating lead key is what says "these
 *    are entries of one list"). Anything short of that shape returns null and
 *    the UI falls back to showing the text as-is — a wrong parse would be
 *    worse than no parse, so every rule here fails closed.
 *
 * Nothing in this file knows any tool's vocabulary. That is the point: a new
 * connector renders decently with zero code written for it, and a per-tool
 * dictionary would rot the day it shipped.
 */
import { type StepField, fieldOf, humanizeKey, isBareUrl } from "./steps";

export interface TextRecord {
  fields: StepField[];
}

/** Every element must be a plain object with at least one own field — one
 *  scalar or array in the list and the whole thing is NOT a record list. Field
 *  order is the author's own (unlike an invocation, a record is written to be
 *  read top-down, so reordering it would editorialize). */
function fromArray(arr: unknown[]): TextRecord[] | null {
  if (arr.length < 2) return null;
  const records: TextRecord[] = [];
  for (const el of arr) {
    if (!el || typeof el !== "object" || Array.isArray(el)) return null;
    const fields = Object.entries(el as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => fieldOf(k, v));
    if (fields.length === 0) return null;
    records.push({ fields });
  }
  return records;
}

/** The MCP transport envelope's `content` array: blocks tagged with a string
 *  `type` ("text", "image", …). They are the MESSAGE, never the data — treating
 *  two text blocks as a two-record list was this module's first real bug. Both
 *  key names come from the MCP spec, not from any tool's vocabulary. */
const isContentBlocks = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((el) => !!el && typeof el === "object" && !Array.isArray(el) && typeof (el as Record<string, unknown>).type === "string");

/** The typed payload, per the spec: `structuredContent` when present, otherwise
 *  the value itself with the transport fields (`content`, `isError`) set aside. */
function dataRoot(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (obj.structuredContent && typeof obj.structuredContent === "object") return obj.structuredContent;
  if (isContentBlocks(obj.content) || typeof obj.isError === "boolean") {
    const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "content" && k !== "isError"));
    return Object.keys(rest).length > 0 ? rest : null;
  }
  return value;
}

export function recordsFromValue(value: unknown): TextRecord[] | null {
  const root = dataRoot(value);
  if (!root || typeof root !== "object") return null;
  if (Array.isArray(root)) return isContentBlocks(root) ? null : fromArray(root);
  // An object that is nothing but one array of objects ({results: [...]}) is
  // that array under a wrapper key — accepted because the shape is unambiguous,
  // never by the key's name. Two properties = a structure with an opinion, and
  // flattening it would drop the other half.
  const props = Object.entries(root as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (props.length === 1 && Array.isArray(props[0][1]) && !isContentBlocks(props[0][1])) return fromArray(props[0][1]);
  return null;
}

/** A single typed object — a weather reading, a status, one entity — becomes
 *  the same label/value fields the params view uses. Only reached when the
 *  text pipeline had nothing better than raw JSON to show (the caller gates on
 *  that), so this never displaces a tool's own prose. */
export function fieldsFromValue(value: unknown): StepField[] | null {
  const root = dataRoot(value);
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const props = Object.entries(root as Record<string, unknown>).filter(([, v]) => v !== undefined);
  // One property is a sentence, not an entity — the plain text already says it.
  if (props.length < 2) return null;
  return props.map(([k, v]) => fieldOf(k, v));
}

/** Homogeneous, short records read better as a table than as cards — the shape
 *  a SQL row set or an inventory listing arrives in. Same keys in the same
 *  order, every value short, at least three rows; anything less regular keeps
 *  the card layout, where per-record variation does not shear the columns. */
export function readsAsTable(records: TextRecord[]): boolean {
  if (records.length < 3) return false;
  const shape = records[0].fields.map((f) => f.label).join("\u0000");
  if (records[0].fields.length < 2 || records[0].fields.length > 8) return false;
  return records.every(
    (r) => r.fields.map((f) => f.label).join("\u0000") === shape && r.fields.every((f) => !f.mono && !f.clipped && f.value.length <= 60),
  );
}

/** An image the tool sent back, as an inline-renderable data URI. Bounded: past
 *  four the rest add scroll, not information. */
export interface ResultImage {
  src: string;
}

export function imagesFromValue(value: unknown): ResultImage[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as Record<string, unknown>).content;
  if (!isContentBlocks(content)) return null;
  const images = content
    .filter((b) => b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")
    .slice(0, 4)
    .map((b) => ({ src: `data:${b.mimeType as string};base64,${b.data as string}` }));
  return images.length > 0 ? images : null;
}

/** A resource the tool pointed at (`resource_link`) or carried (`resource`) —
 *  both block shapes are the MCP spec's own. The UI links http(s) URIs and
 *  shows any other scheme as an identifier. */
export interface ResourceRef {
  name: string;
  uri: string;
  description?: string;
}

export function resourcesFromValue(value: unknown): ResourceRef[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as Record<string, unknown>).content;
  if (!isContentBlocks(content)) return null;
  const refs: ResourceRef[] = [];
  for (const b of content) {
    if (b.type === "resource_link" && typeof b.uri === "string") {
      refs.push({
        name: typeof b.name === "string" && b.name ? b.name : b.uri,
        uri: b.uri,
        ...(typeof b.description === "string" && b.description ? { description: b.description } : {}),
      });
    } else if (b.type === "resource" && b.resource && typeof b.resource === "object") {
      const r = b.resource as Record<string, unknown>;
      if (typeof r.uri === "string") {
        refs.push({ name: typeof r.name === "string" && r.name ? r.name : r.uri, uri: r.uri });
      }
    }
  }
  return refs.length > 0 ? refs.slice(0, 16) : null;
}

/** `Key: value` — key short and word-like (any script), value non-empty. The
 *  length cap is what keeps prose out: a long clause that happens to end in a
 *  colon fails it, and the block/lead-key rules below catch the rest. */
const LINE_RE = /^(\p{L}[\p{L}\p{N} _./-]{0,39}):[ \t]+(\S.*)$/u;

export function recordsFromText(text: string): TextRecord[] | null {
  const blocks = text.split(/\r?\n[ \t]*(?:\r?\n)+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length < 2) return null;
  const records: TextRecord[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const fields = parseBlock(blocks[i]);
    if (!fields) {
      // Only the FINAL block may fail once a list has formed: the server-side
      // output clamp cuts mid-record, and dropping that stub is honest — the
      // truncation is already stated by the surrounding UI.
      if (i === blocks.length - 1 && records.length >= 2) break;
      return null;
    }
    records.push({ fields });
  }
  const lead = records[0].fields[0].label;
  if (!records.every((r) => r.fields[0].label === lead)) return null;
  return records;
}

/** Does this text READ as markdown — a scraped page, a connector's formatted
 *  reply — rather than as plain output? Decided by the density of markdown's
 *  own constructs, never by which tool produced it. The bar is deliberately
 *  high (several links, or several headings): plain text renders fine as plain
 *  text, while prose mis-rendered as markdown mangles every stray asterisk —
 *  so this, too, fails closed. Only the head is sampled: a page's nature shows
 *  in its first screens, and the clamp elsewhere bounds what gets rendered. */
export function looksLikeMarkdown(text: string): boolean {
  const head = text.slice(0, 4000);
  const links = head.match(/\]\(https?:\/\//g)?.length ?? 0;
  if (links >= 3) return true;
  const headings = head.match(/^#{1,6} \S/gm)?.length ?? 0;
  return headings >= 2;
}

function parseBlock(block: string): StepField[] | null {
  const fields: StepField[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (m) {
      const value = m[2].trim();
      fields.push({ label: humanizeKey(m[1]), value, mono: false, ...(isBareUrl(value) ? { url: true } : {}) });
    } else if (fields.length > 0) {
      // A line with no key continues the previous value (hard-wrapped text).
      const prev = fields[fields.length - 1];
      prev.value += " " + line.trim();
      if (prev.url && !isBareUrl(prev.value)) delete prev.url;
    } else {
      return null; // a record announces itself with a field on line one
    }
  }
  // One line is a statement, not a record; requiring two is what keeps `git
  // log`-style output and key: value config chatter out of this rendering.
  return fields.length >= 2 ? fields : null;
}
