/**
 * Search-result normalization — the server half of citations.
 *
 * Search arrives through whatever MCP connector the admin installed, and the
 * connectors return text: Tavily/Exa print `Title:`/`URL:` records into one
 * block, Brave returns one JSON object per block, Firecrawl/SearXNG stringify
 * a whole API response. The MCP spec has no attribution fields (verified
 * against schema 2026-07-28), so the structure has to be recovered HERE, at
 * the one boundary every connector passes through.
 *
 * The extraction is shape-driven and deliberately conservative: it claims a
 * result is "search results" only when it finds at least two records with
 * real http(s) URLs, arriving either under a search-shaped wrapper key, as
 * per-block JSON objects, or as labeled `Title:`/`URL:` text. Anything less
 * confident stays in the ordinary record/table ladder untouched — a wrongly
 * normalized result would DEGRADE (a table of rows has more columns than a
 * source list), so the failure mode to avoid is over-claiming, not missing.
 *
 * Numbered sources ride the persisted tool output under `capkaSources`; the
 * model sees them as `[N] Title — URL` lines (and is asked to cite `[N]`),
 * and the client resolves `[N]` in the answer against the same numbers. A
 * number the model invents matches nothing and stays plain text — visibly
 * inert, never a fabricated link.
 */

export interface SearchSourceRecord {
  title: string;
  url: string;
  snippet?: string;
  /** Publication date/age, verbatim from the connector ("2026-08-27", "3 days
   *  ago") — carried because a "latest news" answer is unusable without it. */
  date?: string;
}

export interface NumberedSource extends SearchSourceRecord {
  n: number;
}

const MAX_RECORDS = 20;
const MAX_TITLE = 200;
const MAX_SNIPPET = 400;
const MAX_DATE = 40;

/** Wrapper keys that mark an array as SEARCH results. Deliberately narrow:
 *  generic `data`/`items` arrays (a DB query, an API listing) must keep their
 *  richer table rendering, so they qualify only via the strict predicate below. */
const SEARCH_KEYS = new Set(["results", "organic", "web", "news", "hits", "sources", "top_stories", "documents"]);
/** Generic wrapper keys — accepted only when nearly every entry looks like a
 *  search hit (url AND title AND snippet), see recordsFromArray(strict). */
const GENERIC_KEYS = new Set(["data", "items"]);

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Collapse a connector-controlled string to one line: control characters and
 *  every newline become a single space. The model reads sources as `[N] Title —
 *  URL` LINES, so a title carrying its own newline could otherwise fabricate a
 *  record line ("real title\n[2] Evil — https://attacker…") that reads exactly
 *  like one of ours. Applied at build AND at the read-side re-validation. */
const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();

function httpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    // Exa-style highlights: an array of strings.
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return (v as string[]).join(" … ").trim();
  }
  return null;
}

function recordFromObject(o: unknown): SearchSourceRecord | null {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const url = httpUrl(r.url) ?? httpUrl(r.link) ?? httpUrl(r.href);
  if (!url) return null;
  const title = pickString(r, ["title", "name", "heading"]) ?? new URL(url).hostname;
  const snippet = pickString(r, ["description", "snippet", "content", "text", "summary", "highlights"]);
  const date = pickString(r, ["published", "published_date", "publishedDate", "publication_date", "date", "published_time", "page_age"]);
  return {
    title: clamp(flat(title), MAX_TITLE),
    url,
    ...(snippet ? { snippet: clamp(flat(snippet), MAX_SNIPPET) } : {}),
    ...(date ? { date: clamp(flat(date), MAX_DATE) } : {}),
  };
}

/** Map an array to records. `strict` (for generic wrapper keys) additionally
 *  requires a snippet on the record and near-total coverage — a column of URLs
 *  in ordinary rows must not turn a table into a source list. */
function recordsFromArray(arr: unknown[], strict: boolean): SearchSourceRecord[] | null {
  if (arr.length < 2) return null;
  const records: SearchSourceRecord[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    const rec = recordFromObject(entry);
    if (!rec || (strict && !rec.snippet)) continue;
    if (seen.has(rec.url)) continue;
    seen.add(rec.url);
    records.push(rec);
    if (records.length >= MAX_RECORDS) break;
  }
  if (records.length < 2) return null;
  const coverage = records.length / Math.min(arr.length, MAX_RECORDS);
  if (strict && coverage < 0.8) return null;
  return records;
}

/** Search-shaped records inside a JSON value: an array under a search wrapper
 *  key (descending two levels of objects, e.g. `{web: {results: […]}}`), or a
 *  generic `data`/`items` array whose entries all read as hits. A bare
 *  top-level array qualifies only under the strict predicate. */
function recordsFromJson(v: unknown, depth = 0): { records: SearchSourceRecord[]; preamble?: string } | null {
  if (Array.isArray(v)) {
    const records = recordsFromArray(v, true);
    return records ? { records } : null;
  }
  if (v === null || typeof v !== "object" || depth > 2) return null;
  const o = v as Record<string, unknown>;
  // A summary the search API itself wrote (Tavily's `answer`) — kept, so
  // normalizing never drops information the model would have seen raw.
  const preamble = typeof o.answer === "string" && o.answer.trim() ? clamp(flat(o.answer), 800) : undefined;
  for (const [k, val] of Object.entries(o)) {
    if (!Array.isArray(val)) continue;
    const key = k.toLowerCase();
    const strict = !SEARCH_KEYS.has(key) && GENERIC_KEYS.has(key);
    if (!SEARCH_KEYS.has(key) && !GENERIC_KEYS.has(key)) continue;
    const records = recordsFromArray(val, strict);
    if (records) return { records, ...(preamble ? { preamble } : {}) };
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = recordsFromJson(val, depth + 1);
      if (found) return preamble && !found.preamble ? { ...found, preamble } : found;
    }
  }
  return null;
}

const LABEL_RE = /^(title|url|link|source|published(?: date)?|author|content|description|snippet|highlights?|score|id)\s*:\s*(.*)$/i;

/** Labeled-text records: `Title: …` / `URL: …` lines, the format Tavily and
 *  Exa print. A record opens at a `Title:` line; lines before the first one
 *  form the preamble (Tavily prints its `answer` there). */
function recordsFromLabeledText(text: string): { records: SearchSourceRecord[]; preamble?: string } | null {
  const records: SearchSourceRecord[] = [];
  const preambleLines: string[] = [];
  let cur: { title?: string; url?: string; snippet?: string[]; date?: string } | null = null;
  const flush = () => {
    const url = cur?.url && httpUrl(cur.url);
    if (cur && url) {
      records.push({
        title: clamp(flat(cur.title || new URL(url).hostname), MAX_TITLE),
        url,
        ...(cur.snippet?.length ? { snippet: clamp(flat(cur.snippet.join(" ")), MAX_SNIPPET) } : {}),
        ...(cur.date ? { date: clamp(flat(cur.date), MAX_DATE) } : {}),
      });
    }
    cur = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^-{3,}$/.test(line)) continue;
    const m = LABEL_RE.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "title") {
        flush();
        cur = { title: val, snippet: [] };
        continue;
      }
      if (!cur) { preambleLines.push(line); continue; }
      if (key === "url" || key === "link" || key === "source") cur.url ??= val;
      else if (key.startsWith("published")) cur.date ??= val;
      else if (key === "content" || key === "description" || key === "snippet" || key.startsWith("highlight")) cur.snippet!.push(val);
      continue;
    }
    // An unlabeled line continues the current record's snippet, or the preamble.
    if (cur) cur.snippet!.push(line);
    else preambleLines.push(line);
  }
  flush();
  if (records.length < 2 || records.length > MAX_RECORDS * 2) return null;
  const preamble = preambleLines.join(" ").trim();
  return {
    records: records.slice(0, MAX_RECORDS),
    ...(preamble ? { preamble: clamp(preamble, 800) } : {}),
  };
}

interface McpResultShape {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

/** The extraction ladder over one MCP tool result. Returns null when nothing
 *  matches confidently — the caller then leaves the result exactly as it was. */
export function extractSearchRecords(result: McpResultShape): { records: SearchSourceRecord[]; preamble?: string } | null {
  if (result.structuredContent) {
    const found = recordsFromJson(result.structuredContent);
    if (found) return found;
  }
  const textBlocks = (result.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim());
  if (textBlocks.length === 0) return null;

  // Brave's shape: one JSON object per text block, each one hit.
  if (textBlocks.length >= 2) {
    const perBlock: SearchSourceRecord[] = [];
    for (const b of textBlocks) {
      const t = b.text!.trim();
      if (!t.startsWith("{")) { perBlock.length = 0; break; }
      try {
        const rec = recordFromObject(JSON.parse(t));
        if (!rec) { perBlock.length = 0; break; }
        perBlock.push(rec);
      } catch { perBlock.length = 0; break; }
    }
    if (perBlock.length >= 2) return { records: perBlock.slice(0, MAX_RECORDS) };
  }

  const joined = textBlocks.map((b) => b.text!).join("\n\n");
  const head = joined.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      const found = recordsFromJson(JSON.parse(joined));
      if (found) return found;
    } catch { /* not one JSON value — fall through to labeled text */ }
  }
  return recordsFromLabeledText(joined);
}

/** Numbered sources off a persisted tool output, if the adapter attached them.
 *  Shared by the model-facing renderer and the chat UI, so both resolve the
 *  same `[N]` against the same list. Re-validated on READ, not only on write:
 *  the rows come out of a jsonb blob that older code, an import, or a bug could
 *  have populated, and the client renders `url` as a raw href — so a non-http(s)
 *  scheme (javascript:, data:) must die here, at the last common gate. */
export function sourcesFromOutput(output: unknown): NumberedSource[] | null {
  if (output === null || typeof output !== "object") return null;
  const v = (output as { capkaSources?: unknown }).capkaSources;
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: NumberedSource[] = [];
  for (const e of v) {
    if (e === null || typeof e !== "object") continue;
    const { n, title, url, snippet, date } = e as Record<string, unknown>;
    const safeUrl = httpUrl(url);
    if (!Number.isInteger(n) || (n as number) < 1 || typeof title !== "string" || !safeUrl) continue;
    out.push({
      n: n as number,
      title: clamp(flat(title), MAX_TITLE),
      url: safeUrl,
      ...(typeof snippet === "string" && snippet ? { snippet: clamp(flat(snippet), MAX_SNIPPET) } : {}),
      ...(typeof date === "string" && date ? { date: clamp(flat(date), MAX_DATE) } : {}),
    });
  }
  return out.length ? out : null;
}

/** What the model reads instead of the raw blob: the connector's own summary
 *  (if any), then one `[N]` line per source. The citing instruction rides the
 *  result itself, so it works even for a model that skimmed the system prompt. */
export function sourcesModelText(sources: NumberedSource[], preamble?: string): string {
  // Titles/snippets are flattened to one line at build time, so only OUR lines
  // start at column 0 — a snippet is indented, keeping the record grammar
  // unforgeable by connector text.
  const lines = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}${s.date ? ` (${s.date})` : ""}${s.snippet ? `\n    ${s.snippet}` : ""}`);
  return [
    preamble,
    "Search results — when your answer uses one, cite it inline as [N] right after the claim:",
    ...lines,
  ].filter(Boolean).join("\n\n");
}
