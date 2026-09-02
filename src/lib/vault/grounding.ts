// The LEAF, and the only import this module has. See Ruling 14: importing `candidates.ts`
// here is a runtime cycle, because `candidates.ts` imports `ownerAuthored()` back.
import { QUOTED, verifyDirectProvenance } from "./quote-match";
import type { SourceClass } from "./claims";

/**
 * THE ONE PRODUCER of a `source_class` value, and the type that makes that true.
 *
 * Slice 1 shipped `source_class` as a plain string with a test asserting that
 * manifest-tier literals appear only in `candidates.ts`. That guard named its own blind
 * spot — "a class computed into a variable and passed as `sourceClass: cls`" — and said
 * the cure is the class carrying its grounding in the TYPE. This is that cure, and it
 * REPLACES the guard rather than joining it: a bare `sourceClass: "owner_authored"` no
 * longer typechecks anywhere, because `ClaimInput.sourceClass` is `ServerClass` and the
 * only casts to it are the three in this file.
 *
 * Three acts can mint one without a model in the loop, and each is server-verifiable:
 * a person's Keep click, a person's edit on their own page, and the boot migration over
 * legacy text nobody ever reviewed. Everything an AGENT causes goes through `classify`,
 * whose input is a REQUIRED discriminated union — a producer that forgets to say where a
 * fact came from fails to compile, and a fourth grounding kind must be added to a union
 * every switch has to re-exhaust.
 *
 * LOW-6, closed here rather than parked again: `user_direct` was a value of two different
 * enums appearing in one argument list — an `origin.kind` and a `source_class`. Only one
 * of them is a `ServerClass`, so the two can no longer be swapped by a typo.
 */
declare const serverClass: unique symbol;
export type ServerClass = SourceClass & { readonly [serverClass]: true };

/** The three casts. There are no others in `src/`, and `model-view.test.ts` asserts it as
 *  a roster equality, so a fourth file minting one fails the suite rather than joining a
 *  list. (A cast inside `__tests__/fixtures.ts` is out of that walk's scope by
 *  construction, which is correct: a test cannot ship.) */
const mint = (c: SourceClass) => c as ServerClass;

/** A person clicked Keep, or edited the row on their own memory page. The text may have
 *  been drafted by the agent; the act that stores it is theirs — the same reasoning
 *  `confirmClaim` already embodies. */
export function ownerAuthored(): ServerClass {
  return mint("owner_authored");
}

/** `migrateMemoryDocs` only. NOT `legacy_confirmed` and not `owner_authored`: nothing in
 *  that document was ever reviewed, and giving it manifest authority unattended at boot
 *  is what `manifest.ts`'s deleted `legacyDoc` fallback was deleted for. */
export function migrationInferred(): ServerClass {
  return mint("agent_inferred");
}

/**
 * THE CLASS A STORED VERSION ALREADY CARRIES, onto a new revision of that same row.
 *
 * NOT A FOURTH PRODUCER, and the difference is the whole reason this is allowed to exist: a
 * producer DECIDES a class from evidence, while this is the IDENTITY on a value some
 * producer already decided and the database already stores. Its output equals its input, so
 * it can open no channel `prompt_access` did not already grant.
 *
 * IT EXISTS FOR `revertNote`, and both alternatives there are wrong in a way this is not.
 * Minting `ownerAuthored()` would promote an agent's words — or a document's — to the
 * always-on manifest tier on one Undo click, which is §10.1's fence crossed by a person who
 * only asked to put a file back. Re-running `classify()` would decide a class from evidence
 * the restored revision no longer carries, and would raise `untrusted_derived` out of its
 * fence in the process. Carrying the stored value changes nothing at all, which is exactly
 * what an undo should change about authority.
 *
 * ONE CALLER, and it has to stay that way, because the argument is a plain `SourceClass`: a
 * caller passing a LITERAL would be minting after all, which is the hole the brand closes.
 * Read it off the row you are restoring and from nowhere else. `model-view.test.ts` asserts
 * the roster.
 */
export function carriedClass(stored: SourceClass): ServerClass {
  return mint(stored);
}

export type Grounding =
  | { kind: "current_user_quote"; quote: string }
  /** The RESOLVED classes of 1..8 handles. Handles are resolved by the caller, which owns
   *  the run-local map; an unresolvable handle rejects the whole mutation before this is
   *  reached (§4.1), so this array is never a partial resolution. */
  | { kind: "retrieved"; classes: SourceClass[] }
  | { kind: "agent_inference" };

export type GroundingContext = {
  /** The statement (or note title+body) being written, RAW. Clause 4 measures its own
   *  words, which is the tie round 1 lacked. */
  statement: string;
  /** `run-context.ts`'s `userTurnText`: the `type: "text"` parts of the last user UI
   *  message and nothing else. Attachment parts and tool output are excluded
   *  STRUCTURALLY — they are not that field. */
  userTurnText: string;
  /** The turn's fold over the whole assembled prompt (§2.3). A plain boolean, so this
   *  module has no opinion about where taint comes from. */
  untrustedIngressSeen: boolean;
};

export type GroundingVerdict = {
  sourceClass: ServerClass;
  /** True only when `current_user_quote` was asked for and did not earn `user_direct`. */
  downgraded: boolean;
  /** AUDIT ONLY (NEW-4). Naming the failed clause to the MODEL is a rephrase-until-it-
   *  passes gradient that exact-hash dedup does not stop: a one-word rephrase has a
   *  different `normalized_hash`, can land `user_direct`, and leaves both rows stored. */
  failedClause: 1 | 2 | 3 | 4 | null;
};

/** At least this many characters, so a one-word coincidence cannot carry the class. */
export const QUOTE_MIN_CHARS = 12;

/** The weakest of a set. Ordered strongest → weakest; `retrieved` takes the last one
 *  present. Written as an ordering rather than a `Math.min` over a lookup table because
 *  the order IS the meaning and a reader has to see it. */
const WEAKEST_FIRST: SourceClass[] = [
  "untrusted_derived",
  "agent_inferred",
  "user_direct",
  "owner_authored",
  "legacy_confirmed",
];

/** Where an agent write lands when it earns nothing stronger. The cap is the whole of
 *  what taint does to a class: `agent_inference` in a tainted turn is
 *  `untrusted_derived`, and so is a failed quote. */
const floorFor = (tainted: boolean): SourceClass => (tainted ? "untrusted_derived" : "agent_inferred");

/**
 * Clause 1+2: the quote occurs verbatim in the user's own text, OUTSIDE any span
 * `QUOTED` matches. The two clauses are one search because "outside the quoted spans" is
 * only answerable against the stripped text — but they report separately, because the
 * audit payload has to say which one failed.
 */
function locateQuote(quote: string, userTurnText: string): 1 | 2 | null {
  if (!userTurnText.includes(quote)) return 1;
  // `QUOTED` is a /g/m/u regex with lastIndex state; replace() resets it, and a fresh
  // string is what clause 2 asks about. A marked paste of a vendor PDF is not the
  // user's words — reused from `candidates.ts`, not reinvented.
  return userTurnText.replace(QUOTED, " ").includes(quote) ? null : 2;
}

export function classify(g: Grounding, ctx: GroundingContext): GroundingVerdict {
  const floor = floorFor(ctx.untrustedIngressSeen);
  switch (g.kind) {
    case "agent_inference":
      return { sourceClass: mint(floor), downgraded: false, failedClause: null };

    case "retrieved": {
      // "Least-trusted among them" over an empty set has no answer, and its natural
      // answer would be fail-open. The schema makes the array 1..8; this is the second
      // half of the same bound, for a caller that bypassed the schema.
      if (g.classes.length === 0) throw new Error("grounding.retrieved requires a non-empty class list");
      const weakest = WEAKEST_FIRST.find((c) => g.classes.includes(c)) ?? "untrusted_derived";
      // THE CAP IS NOT TAINT-ONLY, and that is the half a reader gets wrong. In a CLEAN
      // turn the floor is `agent_inferred`, so the top three entries of WEAKEST_FIRST can
      // never come out of this arm: grounding a write on a `manifest`-class row does not
      // make the write `manifest`, because the AGENT composed the sentence. `user_direct`
      // is reserved for the statement-to-quote tie and is unreachable from here by
      // construction. A tainted turn then lowers the floor further, which is the taint
      // half. Pinned by `it("caps a retrieved write at agent_inferred even in a CLEAN
      // turn")` — without that case, this line reads as taint plumbing and gets "fixed".
      const idx = (c: SourceClass) => WEAKEST_FIRST.indexOf(c);
      const capped = idx(weakest) < idx(floor) ? weakest : floor;
      return { sourceClass: mint(capped), downgraded: false, failedClause: null };
    }

    case "current_user_quote": {
      // FAILURE DEGRADES, NEVER REFUSES (controller ruling). A refusal would teach the
      // model to retry with a different quote until one passed, which is the
      // optimization pressure this predicate least needs.
      const located = g.quote.length < QUOTE_MIN_CHARS ? 3 : locateQuote(g.quote, ctx.userTurnText);
      if (located !== null) {
        return { sourceClass: mint(floor), downgraded: true, failedClause: located };
      }
      // CLAUSE 4, and it is the sharpest finding of the spec's two review rounds. The
      // quote says WHERE IN THE TURN TO LOOK; this says the claim is made of what is
      // there. Without it the model supplies both fields independently and any ordinary
      // sentence the user typed mints `manifest` for arbitrary text.
      if (!verifyDirectProvenance(ctx.statement, g.quote)) {
        return { sourceClass: mint(floor), downgraded: true, failedClause: 4 };
      }
      // NOT capped by taint, deliberately: a person who uploads a file and then types
      // their new address in the same turn has still typed their own address, and taxing
      // that sentence for the file's presence would make a tainted turn unusable for
      // ordinary memory. What taint DOES bar is the supersede (§4.5 step 5), which is a
      // different decision made by a different caller.
      return { sourceClass: mint("user_direct"), downgraded: false, failedClause: null };
    }
  }
}

/**
 * §12's retention table, as a function, and it lives HERE rather than in `notes.ts`
 * because it is keyed on the class and this module is the class's only producer
 * (Ruling 13). Both claim writers and both note writers call it INTERNALLY — it is not a
 * parameter — so the arming §4.5 step 8 requires ("at insert, by the writer, not by a
 * trigger and not by a backfill") cannot be forgotten by a caller. It also keeps
 * `notes.ts` from needing an import out of `claims.ts` for it.
 *
 * `user_direct` and `owner_authored` NEVER expire: the person said it, and a horizon on
 * their own words would be the system quietly forgetting what it was told. A new revision
 * re-arms from ITS OWN class rather than inheriting, which is why every writer calls this
 * with the class it is about to store and never with the predecessor's.
 */
export const HORIZON_DAYS = 90;

export function horizonFor(c: SourceClass): Date | null {
  if (c === "user_direct" || c === "owner_authored" || c === "legacy_confirmed") return null;
  return new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
}
