import { EDGE_TOKEN_RE, UNRESOLVED_LINK, edgeIdsIn, edgeToken } from "./links";

/**
 * THE ARITHMETIC OF AN IN-PLACE NOTE EDIT — pure, no database, no mint, no turn context.
 *
 * `memory_open` shows the model a RENDERED body: every canonical `[[capka-edge:<id>]]`
 * token substituted for its target's current title (`[[Reporting]]`), or for
 * `UNRESOLVED_LINK` when the model's channel may not read that target at all. The database
 * stores the TOKENS. So an `old_str` the model copied off its own screen does not occur in
 * the stored body, and an implementation that matched the two directly would answer
 * "not found" for text the model is looking straight at.
 *
 * This module is the translation, and it is a pure function of `(storedBody, edges)` for
 * one reason above every other: the TITLES are not this module's to read. They come from
 * `model-view.ts`, which is the only module allowed to decide which titles a channel
 * admits, and they arrive here as data. A version of this that queried for them would be a
 * second answer to that question, one module further from the one that owns it.
 *
 * WHAT IS DELIBERATELY NOT HERE. No regex tier and no model-driven repair (see
 * `applyStrReplace`'s fallback); no link creation, because §7 is that a link is an id-to-id
 * edge the server mints and never text the model types; and no bound on length, which is
 * the writer's — it holds the constants and the transaction the refusal has to precede.
 */

/** One live `references` edge FROM the note being edited, with the title the model's
 *  channel showed for it — `null` when it showed `UNRESOLVED_LINK` instead, which covers a
 *  target that is off-channel, sensitive, superseded or gone. A token in the body with no
 *  entry here is `null` too: an edge closed since the body was written renders the same
 *  way, and the model cannot tell the two apart, so neither does this. */
export type RenderedEdge = { edgeId: string; title: string | null };

export type EditRefusal =
  /** Two live edges render as the same title, or the body carries two unresolvable tokens
   *  and the edit names `[[link removed]]`. The address is genuinely ambiguous and there is
   *  no safe pick; `title` is what to say back. */
  | { ok: false; reason: "ambiguous_link"; title: string }
  /** A canonical token appeared in the replacement text without having been in the text it
   *  replaces. Links are not typed into existence. */
  | { ok: false; reason: "bad_link" }
  /** The edit would leave a `[[capka-edge:` that no longer closes — a token cut in half by a
   *  match that started or ended inside one, or a half-written one in the replacement text.
   *  A severed token stops matching the pattern, so the raw edge id renders verbatim on
   *  every surface, and the link counts as removed on the way past. */
  | { ok: false; reason: "split_link" }
  | { ok: false; reason: "no_match" }
  /** The 1-based lines each occurrence starts on, so the reply can say where to add
   *  context. */
  | { ok: false; reason: "ambiguous_match"; lines: number[] }
  /** `lines` is the file's line count, which is the upper end of the legal range. */
  | { ok: false; reason: "bad_line"; lines: number };

export type EditResult =
  | {
      ok: true;
      /** The new STORED body — tokens, not titles. */
      body: string;
      /** Edge ids the edit dropped out of the body. The writer closes exactly these, in the
       *  same transaction, because §4.8 is symmetric: an edge that outlives its token
       *  renders a link the body does not make. */
      linksRemoved: string[];
      /** The 1-based line range the change occupies IN THE NEW BODY, for the snippet the
       *  reply shows back. */
      changedFrom: number;
      changedTo: number;
      /** Whether the exact tier missed and the whitespace-tolerant fallback matched. */
      fuzzy: boolean;
    }
  | EditRefusal;

/** How many lines a body has, and therefore the top of `insert_line`'s legal range. An
 *  EMPTY body has zero lines rather than one: `"".split("\n")` is `[""]`, and reporting a
 *  line the file does not have would put a legal `insert_line` outside the file. */
export function lineCountOf(body: string): number {
  return body === "" ? 0 : body.split("\n").length;
}

/** The 1-based line a character offset sits on. */
const lineAt = (body: string, offset: number): number => body.slice(0, offset).split("\n").length;

/** `[[...]]` with no nested brackets — the rendered form of a link, and also the literal a
 *  model may type by hand, which is why the two are told apart by their CONTENTS below and
 *  not by the pattern. */
const RENDERED_LINK_RE = /\[\[([^[\]]*)\]\]/g;

/** What the body's tokens render as, indexed both ways.
 *
 *  Only tokens PRESENT IN THE BODY are indexed. An edge that exists but is not mentioned
 *  renders nowhere, so a title the model saw can never have come from one, and admitting it
 *  here would let a title map to a token the body does not contain. */
function linkIndex(storedBody: string, edges: RenderedEdge[]) {
  const titleOf = new Map(edges.map((e) => [e.edgeId, e.title]));
  const byTitle = new Map<string, string[]>();
  const dead: string[] = [];
  for (const id of edgeIdsIn(storedBody)) {
    const title = titleOf.get(id) ?? null;
    if (title === null) {
      dead.push(id);
      continue;
    }
    byTitle.set(title, [...(byTitle.get(title) ?? []), id]);
  }
  return { byTitle, dead };
}

/**
 * ONE RENDERED STRING BACK INTO STORED FORM.
 *
 * `[[Title]]` becomes the token of the one live edge that renders as that title;
 * `[[link removed]]` becomes the one unresolvable token, when there is exactly one. Two
 * candidates for either is a refusal rather than a pick — the model would have no way to
 * know which link it just edited, and neither would the person reading the diff.
 *
 * A `[[Title]]` that matches NO edge stays literal text, which is §7's rule read forwards:
 * the model cannot type a link into existence, so text that looks like one is text.
 *
 * AMBIGUITY IS RAISED ONLY WHERE IT BITES — when the duplicated title actually appears in
 * the string being mapped. A note may perfectly well link two files that happen to share a
 * title and be edited somewhere else entirely, and refusing that edit would make a
 * coincidence elsewhere in the file into a permanent block on editing it.
 */
export function mapRenderedToStored(
  rendered: string,
  storedBody: string,
  edges: RenderedEdge[],
): { ok: true; text: string } | { ok: false; reason: "ambiguous_link"; title: string } {
  const { byTitle, dead } = linkIndex(storedBody, edges);
  const removedLabel = UNRESOLVED_LINK.slice(2, -2);
  let ambiguous: string | null = null;
  const text = rendered.replace(new RegExp(RENDERED_LINK_RE.source, "g"), (all, inner: string) => {
    // Already stored form. It reaches this function only inside an `old_str` the model
    // copied from somewhere it should not have; `applyStrReplace` decides what that means.
    if (inner.startsWith("capka-edge:")) return all;
    if (inner === removedLabel) {
      if (dead.length === 1) return edgeToken(dead[0]);
      if (dead.length > 1) ambiguous ??= removedLabel;
      return all;
    }
    const ids = byTitle.get(inner);
    if (!ids) return all;
    if (ids.length > 1) {
      ambiguous ??= inner;
      return all;
    }
    return edgeToken(ids[0]);
  });
  return ambiguous === null ? { ok: true, text } : { ok: false, reason: "ambiguous_link", title: ambiguous };
}

/**
 * THE STORED SPAN OF EVERY COMPLETE EDGE TOKEN, so a splice can be checked against them.
 *
 * A token is the one region of a body that has no interior a text edit may address: it is an
 * opaque id with brackets, and half of one is not a shorter link but a printed id. So an edit
 * may replace a token WHOLE, and may span one, and may not begin or end inside one.
 */
function tokenSpans(body: string): { start: number; end: number }[] {
  const re = new RegExp(EDGE_TOKEN_RE.source, "g");
  const out: { start: number; end: number }[] = [];
  for (const m of body.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** How many `[[capka-edge:` openings a body holds that no complete token accounts for. A
 *  COUNT rather than a presence test: a body that somehow already holds a severed token must
 *  stay editable everywhere else, and refusing every edit to it is the one way to make the
 *  damage permanent. What is forbidden is ADDING one. */
function orphanTokenCount(body: string): number {
  const rest = body.replace(new RegExp(EDGE_TOKEN_RE.source, "g"), "");
  return rest.split("[[capka-edge:").length - 1;
}

/** Whether a splice at `[start, end)` would cut through a token of `body`. Touching a
 *  boundary is fine — that is replacing the token whole, or the text beside it. */
const cutsAToken = (body: string, start: number, end: number): boolean =>
  tokenSpans(body).some((t) => (start > t.start && start < t.end) || (end > t.start && end < t.end));

/** Every start offset of `needle` in `haystack`. Overlapping occurrences count once each
 *  from where they start, which is what a line report has to say. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r";

/**
 * THE FORGIVING TIER'S NORMAL FORM, with a map back to the stored offsets.
 *
 * Per line: runs of spaces and tabs collapse to one space, and a run that ends the line
 * disappears. Nothing else — no case folding, no punctuation, no reflowing. The map is what
 * makes the tier safe: a match is found in the normalised text and the STORED bytes under
 * it are what gets replaced, so the file never picks up the normalisation.
 */
function normalizeWithMap(s: string): { text: string; from: number[]; to: number[] } {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\n") {
      out.push("\n");
      from.push(i);
      to.push(i + 1);
      i += 1;
      continue;
    }
    if (isSpace(s[i])) {
      const start = i;
      while (i < s.length && isSpace(s[i])) i += 1;
      // A run that ends the line (or the text) is trailing whitespace and is dropped.
      if (i >= s.length || s[i] === "\n") continue;
      out.push(" ");
      from.push(start);
      to.push(i);
      continue;
    }
    out.push(s[i]);
    from.push(i);
    to.push(i + 1);
    i += 1;
  }
  return { text: out.join(""), from, to };
}

/** Where a needle occurs in the stored body once whitespace is forgiven, as stored spans. */
function fuzzySpans(storedBody: string, needle: string): { start: number; end: number }[] {
  const body = normalizeWithMap(storedBody);
  const want = normalizeWithMap(needle).text;
  if (!want) return [];
  return occurrences(body.text, want).map((i) => ({
    start: body.from[i],
    end: body.to[i + want.length - 1],
  }));
}

/** The links a body no longer names. Computed over WHOLE bodies rather than over the edited
 *  span, so a token that appears twice and loses one copy is correctly NOT reported: the
 *  note still makes that link. */
const droppedLinks = (before: string, after: string): string[] =>
  edgeIdsIn(before).filter((id) => !after.includes(edgeToken(id)));

/** Canonical tokens written out literally in a string the model composed. */
const typedTokens = (s: string): string[] => edgeIdsIn(s);

/**
 * `str_replace`, on the text the model was shown.
 *
 * THE EXACT TIER FIRST, byte for byte, with no normalisation at all — the same contract as
 * Claude's own memory tool, and the model has just read the text. A CRLF body matches a
 * CRLF `old_str` and nothing quietly rewrites either.
 *
 * THEN ONE FALLBACK, and only when the exact tier found NOTHING: per-line trailing
 * whitespace trimmed on both sides and runs of spaces and tabs collapsed. It exists because
 * a model reproduces a rendered line without its trailing space far more often than it
 * invents words — the failure it forgives is transcription, not comprehension. There is no
 * regex tier and no repair step: both of those forgive a model that got the CONTENT wrong,
 * which is the case that must fail loudly.
 *
 * Ambiguity is never resolved by picking. Two matches is a refusal naming the lines, in
 * either tier.
 */
export function applyStrReplace(a: {
  storedBody: string;
  edges: RenderedEdge[];
  oldStr: string;
  newStr: string;
}): EditResult {
  // BEFORE the mapping, on the RAW strings: a canonical token in the replacement that was
  // not in the text being replaced is the model minting a link out of an id it should never
  // have seen. Tokens carried across unchanged are fine — that is an edit that kept a link.
  const carried = new Set(typedTokens(a.oldStr));
  if (typedTokens(a.newStr).some((id) => !carried.has(id))) return { ok: false, reason: "bad_link" };

  const mappedOld = mapRenderedToStored(a.oldStr, a.storedBody, a.edges);
  if (!mappedOld.ok) return mappedOld;
  const mappedNew = mapRenderedToStored(a.newStr, a.storedBody, a.edges);
  if (!mappedNew.ok) return mappedNew;

  let fuzzy = false;
  let spans = occurrences(a.storedBody, mappedOld.text).map((i) => ({
    start: i,
    end: i + mappedOld.text.length,
  }));
  if (spans.length === 0) {
    spans = fuzzySpans(a.storedBody, mappedOld.text);
    fuzzy = spans.length > 0;
  }
  if (spans.length === 0) return { ok: false, reason: "no_match" };
  if (spans.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_match",
      lines: [...new Set(spans.map((s) => lineAt(a.storedBody, s.start)))],
    };
  }

  const [span] = spans;
  // TOKEN-ATOMIC, and checked on the SPAN before the splice rather than on the result alone:
  // `droppedLinks` reads a severed token as an absent one and the writer would then close a
  // live edge the person never asked to remove, so the refusal has to come first.
  if (cutsAToken(a.storedBody, span.start, span.end)) return { ok: false, reason: "split_link" };
  const body = a.storedBody.slice(0, span.start) + mappedNew.text + a.storedBody.slice(span.end);
  // The second half: replacement text carrying a `[[capka-edge:` that never closes. It is
  // not a complete token, so the `bad_link` check above does not see it, and it prints an id.
  if (orphanTokenCount(body) > orphanTokenCount(a.storedBody)) return { ok: false, reason: "split_link" };
  return {
    ok: true,
    body,
    linksRemoved: droppedLinks(a.storedBody, body),
    changedFrom: lineAt(body, span.start),
    changedTo: lineAt(body, span.start + mappedNew.text.length),
    fuzzy,
  };
}

/**
 * `insert`, with Claude's own line semantics: the text goes AFTER line `insert_line`, `0`
 * puts it before the first line, and the file's own line count appends. One trailing
 * newline is trimmed off the inserted text, because the insertion already lands on lines of
 * its own and a model that ends its paragraph with a newline means the paragraph.
 *
 * THE INSERTED TEXT IS NEVER MAPPED. `[[Title]]` in it stays literal text even when an edge
 * of that name exists on this note: mapping it would mint a SECOND token for one edge —
 * §7's "typed into existence" case arriving through the back door — while a `str_replace`
 * that carries a title across is moving a token the body already holds. That asymmetry is
 * the rule, not an oversight.
 */
export function applyInsert(a: { storedBody: string; insertLine: number; insertText: string }): EditResult {
  const lines = a.storedBody === "" ? [] : a.storedBody.split("\n");
  if (!Number.isInteger(a.insertLine) || a.insertLine < 0 || a.insertLine > lines.length) {
    return { ok: false, reason: "bad_line", lines: lines.length };
  }
  if (typedTokens(a.insertText).length) return { ok: false, reason: "bad_link" };

  const text = a.insertText.replace(/\r?\n$/, "");
  const added = text.split("\n");
  const next = [...lines.slice(0, a.insertLine), ...added, ...lines.slice(a.insertLine)];
  const body = next.join("\n");
  // An insert lands on whole lines and a token holds no newline, so it cannot CUT one. What
  // it can still do is carry a half-written token in its own text.
  if (orphanTokenCount(body) > orphanTokenCount(a.storedBody)) return { ok: false, reason: "split_link" };
  return {
    ok: true,
    body,
    // An insert adds text; it can drop no token, so there is nothing to close.
    linksRemoved: [],
    changedFrom: a.insertLine + 1,
    changedTo: a.insertLine + added.length,
    fuzzy: false,
  };
}

