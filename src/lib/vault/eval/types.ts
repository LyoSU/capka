import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One fact a careful person would want kept from a turn.
 *
 *  `gist` is English even where the turn is not — see `README.md`: the specimen is in
 *  its own language, the labels are in the repo's. Matching a statement to a gist is
 *  the judge's job, because the extractor is asked to reuse the speaker's wording and
 *  so its output is not predictable character by character.
 *
 *  The structural fields are NOT judged. They are enumerated values, so once an item
 *  is matched to a gist they are compared directly. A field left undefined asserts
 *  nothing — several turns genuinely do not pin down a scope. */
export interface ExpectedFact {
  gist: string;
  scope?: "user" | "project";
  sensitive?: boolean;
  from?: "user" | "assistant";
  quoted?: boolean;
  /** A correct statement for this fact, in the SPECIMEN's language. Not an expected
   *  output — the extractor is free to word it differently. It exists so the judge's
   *  positive control can be cross-lingual: feeding it English gists as if they were
   *  extracted statements would test the judge on the one case it never faces. */
  exemplar?: string;
}

export interface Fixture {
  id: string;
  lang: "uk" | "en" | "mixed";
  /** Why this turn is in the set. Read by whoever has to decide whether a regression
   *  here matters — a corpus whose entries cannot explain themselves rots into a
   *  number nobody can act on. */
  why: string;
  user: string;
  assistant: string;
  /** Empty means the correct answer is to extract nothing at all. */
  expect: ExpectedFact[];
  /** Things a model might plausibly extract here that would be wrong. English, and
   *  matched by the judge like `gist` is. */
  forbid: string[];
  /** A credential planted verbatim in the turn text. Any extracted item containing it
   *  must carry `sensitive: true`. This is the one literal comparison in the harness,
   *  and it is a parameter of the fixture that planted it — never a global list of
   *  things that look like secrets, which is the shape this feature already rejected. */
  plantedSecret?: string;
  /** This turn's `forbid` entries are a SAFETY claim, not a quality one: a hit is a
   *  release-blocking failure rather than a point off the score. */
  safety?: boolean;
  /** Prose note: what an earlier fact this turn replaces would have been. Not asserted
   *  — merging does not work yet, and the corpus records the case rather than the
   *  hoped-for behaviour. */
  supersedes?: string;
}

const CORPUS = fileURLToPath(new URL("./corpus.jsonl", import.meta.url));

/**
 * Read and validate the corpus.
 *
 * Throws on the first bad line, naming it. A silently-dropped fixture is the worst
 * failure this file could have: the score would still compute, still look reasonable,
 * and quietly stop covering whatever that line was testing — which for this set means
 * a credential or an injection could leave the safety gate without anyone noticing.
 */
export function loadCorpus(): Fixture[] {
  const lines = readFileSync(CORPUS, "utf8").split("\n");
  const out: Fixture[] = [];
  const seen = new Set<string>();

  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const where = `corpus.jsonl:${idx + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`${where}: not valid JSON — ${(e as Error).message}`);
    }
    const f = raw as Fixture;
    if (!f.id) throw new Error(`${where}: no id`);
    if (seen.has(f.id)) throw new Error(`${where}: duplicate id "${f.id}"`);
    seen.add(f.id);
    if (!["uk", "en", "mixed"].includes(f.lang)) throw new Error(`${where}: bad lang "${f.lang}"`);
    if (!f.user || !f.assistant) throw new Error(`${where}: a turn needs both halves`);
    if (!Array.isArray(f.expect) || !Array.isArray(f.forbid)) throw new Error(`${where}: expect/forbid must be arrays`);
    for (const e of f.expect) if (!e.gist) throw new Error(`${where}: an expected fact with no gist`);
    // A planted secret that is not actually in the turn tests nothing, and would pass
    // its gate forever while reading like coverage.
    if (f.plantedSecret && !(f.user + f.assistant).includes(f.plantedSecret)) {
      throw new Error(`${where}: plantedSecret is not present in the turn text`);
    }
    out.push(f);
  });

  return out;
}
