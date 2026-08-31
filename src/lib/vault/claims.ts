import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, claimEvidence, noteClaims, vaultClaims, vaultNotes } from "@/lib/db/schema";
// Runtime, and it is safe: `grounding.ts` imports only the leaf `quote-match.ts` plus a
// TYPE from here, so nothing travels back at runtime. `horizonFor` is called INSIDE both
// inserts rather than passed in — see `ClaimInput.sourceClass`.
import { horizonFor, type ServerClass } from "./grounding";
import { deleteNode, insertNode } from "./nodes";
import { projectClaimDoc } from "./search-documents";
import { spaceAcceptsWrites, type Ex } from "./spaces";

export type Actor = { kind: "user" | "agent" | "system"; id?: string };

/** The channel a stored row may ever reach a model through — the TS name for
 *  `vault_claims.prompt_access` and `vault_note_versions.prompt_access`, which are two
 *  copies of one generated expression.
 *
 *  It lives here beside `SourceClass` because it is that column's function and this module
 *  is where the claim head reads it. It is EXPORTED rather than written inline because
 *  `NoteHead` needs the same four values: slice 2 would otherwise have spelled the union a
 *  third time, and a fourth channel added to one copy and not the others is the shape this
 *  file's history is made of. Naming it is not a second implementation of the rule — the
 *  rule is the generated column, and `model-view.ts` remains the only module that SELECTS
 *  on it. */
export type PromptAccess = "manifest" | "memory_search" | "knowledge_search" | "owner_only";

export type ClaimHead = {
  id: string;
  revision: number;
  statement: string;
  slotKey: string | null;
  value: unknown;
  reviewStatus: string;
  sensitive: boolean;
  /** The channel that may ever show this row to a model — GENERATED, so it is read here
   *  and written nowhere. `modelTextOf` is its only reader: the lost-CAS reply has to make
   *  the same decision as the mints, off a head the caller already had in hand. */
  promptAccess: PromptAccess;
};

/**
 * `reviewStatus` is deliberately ABSENT, and its absence is the authority cutover.
 *
 * It used to be caller data, and the boot migration used that to mint `confirmed`
 * claims directly — a writer declaring its own output approved. Every new claim now
 * lands at the column's `unverified` default and only `confirmClaim` can move it, so
 * "the model sees only what a person approved" is enforced by there being one write
 * that grants approval, not by every writer remembering to ask for the right value.
 *
 * The one row that can be born `confirmed` is a supersede's successor that rewrote no
 * text — the SAME words on a new row, carrying the approval they already had. That is
 * not a second grant of authority and it cannot become one: see `updateClaim`, where the
 * condition is read off the resulting row rather than off the caller's patch.
 *
 * Recall why this matters more than it reads: a column DEFAULT was already an unlisted
 * writer in this feature's history. A caller-supplied authorization field is the same
 * hazard with a name on it.
 */
export type ClaimInput = {
  spaceId: string;
  statement: string;
  slotKey?: string;
  value?: unknown;
  origin: Record<string, unknown>;
  sensitive?: boolean;
  topicNoteId?: string;
  /** REQUIRED, and BRANDED. `source_class` is NOT NULL with no default, so an unlisted
   *  writer cannot inherit the strongest class by omission — and now it cannot state one
   *  either: `ServerClass` is minted only by `grounding.ts`, so `sourceClass:
   *  "owner_authored"` does not typecheck.
   *
   *  It also decides `expires_at`, which is why there is no `expiresAt` parameter beside
   *  it: both inserts call `horizonFor` on the class they are ABOUT TO STORE. A supersede
   *  therefore re-arms from the replacement's class and never inherits the predecessor's
   *  horizon — the same rule, and the same reason, as the class itself not being
   *  inherited. A parameter would be a second way to answer one question. */
  sourceClass: ServerClass;
  /** The task that wrote it; `memory_forget`'s same-task bound reads it in slice 2. An
   *  owner action has no task and passes nothing. */
  createdTaskId?: string;
};

export type EvidenceInput = {
  relation?: "supports" | "refutes" | "derived_from";
  fragmentId?: string;
  messageId?: string;
  quoteSnapshot?: string;
  locatorSnapshot?: unknown;
};

/** Exactly the `ClaimHead` fields — a claim's text only reaches callers who
 *  cleared the space filter, so there is no room for an "extra" column here. */
const HEAD = {
  id: vaultClaims.id,
  revision: vaultClaims.revision,
  statement: vaultClaims.statement,
  slotKey: vaultClaims.slotKey,
  value: vaultClaims.value,
  reviewStatus: vaultClaims.reviewStatus,
  sensitive: vaultClaims.sensitive,
  promptAccess: vaultClaims.promptAccess,
};

/** The version chain cannot cycle: `uniq_vclaims_one_successor` allows at most
 *  one successor and a successor is always newer. But an unbounded `while` over
 *  data is how a service hangs, so the bound is explicit. */
const MAX_CHAIN = 1000;

/**
 * Screens a row's text for secret-shaped content. It lives in THIS module because
 * `createClaim` and `updateClaim` are the only two statements that put a row in
 * `vault_claims`, so a screen applied by both covers every writer by construction.
 *
 * WHAT THIS IS, since the authority cutover: an ADVISORY FLAG, not a security
 * boundary. Nothing reaches the model's prompt that a person has not confirmed on the
 * memory page, so the person sees a statement before the model ever can — which makes
 * the HUMAN the classifier, and makes that classification universal by construction:
 * it holds for Ukrainian, for Polish, and for a language nobody has thought about. A
 * miss here no longer breaches anything; it means a row was not highlighted for the
 * person deciding on it. A heuristic in that position is allowed to be incomplete, and
 * this comment is where that incompleteness is admitted rather than implied away.
 *
 * WHAT WAS DELETED, and why it is not coming back. There used to be a list of named
 * patterns: `password|secret|token|api_key|authorization` assignments, plus `sk-`,
 * `ghp_`, `xox[bpas]-`, `AKIA`, PEM headers and inline-credential URIs. The lexical
 * half only ever spoke English: it caught `password: hunter2secret` and missed the
 * same sentence written with the Ukrainian, German or Turkish word for "password" — in
 * a product whose first-class locale is Ukrainian. The obvious repair is to add the
 * Ukrainian nouns, and that is the trap: it fixes one language, misses the next, and
 * every new locale needs a new list, so the result LOOKS like coverage while being
 * absent exactly where nobody enumerated. The provider prefixes are the same hardcode
 * with better manners — an enumeration of the vendors somebody happened to think of.
 * A mechanism that cannot be universal is better not built.
 *
 * WHAT REMAINS is the half that generalises: a long unbroken opaque run is anomalous
 * by SHAPE, not by vocabulary, so it works in every language and for every vendor. A
 * real `sk-proj-…` key still clears it on its own body (the hyphenated prefix splits
 * off and the remainder is far over the floor); `password: hunter2` does not, and that
 * is the accepted cost, paid by a person reading their own review queue.
 *
 * It has been at the wrong COLUMN, which is why it reads three. Both writers once ran
 * it on `statement` alone while `slot_key` was printed verbatim to the model by
 * `memory_search`, so a credential in the key with a clean sentence produced a
 * non-sensitive claim that handed the key back on every later search. All three
 * text-bearing columns are screened: `statement`, `slot_key` and `value`. The latter
 * two are paths, not prose, and are screened accordingly — see `pathishSecret`.
 */
/** A long unbroken base64/hex-ish run — deliberately EXCLUDING `-` from the class.
 *  Including it (an earlier version did) also matched ordinary hyphenated things an
 *  office user states as plain fact — a URL slug, a preview-deploy hostname, a UUID —
 *  which this screen must not swallow. A 40-char hex commit sha, a bare base64 token and
 *  a `github_pat_…` fine-grained PAT all still clear the floor without a hyphen.
 *
 *  It is an ENTROPY guess, and what makes the guess safe is that a statement is prose:
 *  an unbroken 28-character run of that class is anomalous in a sentence. It is not
 *  anomalous in a path — see `pathishSecret`. */
const OPAQUE_RUN = /\b[A-Za-z0-9+/_]{28,}={0,2}\b/;

export function looksLikeSecret(statement: string): boolean {
  return OPAQUE_RUN.test(statement);
}

/**
 * The same screen for text that is a PATH rather than prose: a slot key, and the JSON
 * of a structured value.
 *
 * `looksLikeSecret` unchanged is the wrong tool for those, and the repo's own fixture
 * proved it: `/` and `_` are in the run's character class, which is exactly what a slot
 * key is made of, so `suppliers/acme_corp/payment_terms` is 33 characters of pure match
 * and the screen fires on the DESIGN. So the guess is made per path SEGMENT, where a
 * long opaque run means what it meant in prose. Depth stops being evidence of anything.
 *
 * ACCEPTED: a single segment of 28+ unbroken characters is still screened, so a slot
 * key like `annual_supplier_payment_schedule` is flagged. Left in place deliberately —
 * that shape is also what a bare, unprefixed token looks like.
 */
function pathishSecret(text: string): boolean {
  return text.split("/").some((seg) => OPAQUE_RUN.test(seg));
}

/** The row's `value` as the text the screen reads: JSON, because that is what the
 *  column holds and what any later reader would print.
 *
 *  `JSON.stringify` returns `undefined` for a value that does not serialize and
 *  THROWS on a circular one. Neither is answered with "abort the write", and neither
 *  leaves an unscreened row behind either: the column is `jsonb`, so a value this
 *  cannot render is a value the INSERT below refuses anyway. Screened per column
 *  rather than by concatenating the three — `\s` in the named-secret pattern spans a
 *  newline, so a joined string would let a statement ending in "password:" match a
 *  slot key that begins the next line. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** The screen over one FORM of a row's text. Not called directly by the writers — see
 *  `secretShaped`, which is the rule they hold. */
function screenOnce(statement: string, slotKey: string | null | undefined, value: unknown): boolean {
  return looksLikeSecret(statement) || pathishSecret(slotKey ?? "") || pathishSecret(valueText(value));
}

/**
 * The screen over a whole row, in ONE definition, taking the text AS GIVEN and
 * answering for both the raw form and the form the row will actually hold.
 *
 * Both forms, because either alone is wrong in a way somebody has already exploited on
 * paper. Screening only the STORED form turns the size cap into an evasion gadget: a
 * 501-character statement ending in a 28-character opaque token matches raw,
 * `fitStatement` drops one character, and the stored 500 no longer matches — so it is
 * written non-sensitive with the missing character recoverable in about 65 guesses.
 * Screening only the RAW form hides the wrong string, because what a later reader
 * prints is the stored one. So: the OR, for statements, for slot keys and for the JSON
 * of a structured value alike.
 *
 * Callers pass RAW text. `fitStatement`/`fitSlotKey` are applied in here rather than at
 * the call sites, so a writer cannot accidentally hand this the already-clamped string
 * and get back the one-sided answer — which is exactly what the boot migration used to
 * do.
 *
 * Two call sites — both claim writers — plus the candidate ledger, which needs the same
 * answer before any row exists in order to mark the proposal for the person reviewing
 * it. They must not drift: two copies of one rule reading different columns is how a
 * credential in a slot key once routed one way and was written the other.
 */
export function secretShaped(statement: string, slotKey: string | null | undefined, value: unknown): boolean {
  return screenOnce(statement, slotKey, value) || screenOnce(fitStatement(statement), fitSlotKey(slotKey), value);
}

/** What a fact may take up in a prompt, and what shape it may take there.
 *
 *  A confirmed head is injected verbatim into the volatile prompt tier on EVERY later
 *  turn of its scope, so its size and its line structure are prompt properties, not
 *  cosmetics. Both used to be enforced in exactly one place — `memory_propose`'s zod
 *  schema — and both other writers walked past it: extraction accepts whatever the aux
 *  model returns (bounded only by 2048 output tokens, roughly 8KB), and a confirm
 *  supersedes a head with the candidate's text verbatim. `manifest.ts` then budgeted
 *  the prompt on the strength of the tool's cap, i.e. on a rule that held at one of
 *  three entrances.
 *
 *  So it sits here, beside the secret screen, on the writers themselves — a fourth
 *  writer cannot appear behind it.
 *
 *  Newlines collapse rather than being rejected. The manifest fences a fact as
 *  `- «…»`, a fence built for one line: a statement containing `\n## Rules\n…` renders
 *  its tail OUTSIDE the guillemets, indistinguishable from the manifest's own
 *  structure, on every turn. Truncation likewise beats refusal — the alternative to a
 *  clamped fact is a silently dropped one, and the over-long shapes this actually
 *  meets are pasted slabs, not carefully worded 501-character facts. */
export const STATEMENT_MAX_CHARS = 500;
export const SLOT_KEY_MAX_CHARS = 120;

export function fitStatement(statement: string): string {
  return statement.replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, STATEMENT_MAX_CHARS);
}

export type SourceClass =
  | "legacy_confirmed" | "owner_authored" | "user_direct" | "agent_inferred" | "untrusted_derived";

/** The exact-dedup key's canonical rendering of a structured value. Key order is sorted
 *  recursively because `JSON.stringify` is insertion-ordered, and two writers that built
 *  the same object differently would otherwise produce two keys for one fact. This is a
 *  FROZEN expression, like `migrate-memory-docs.ts`'s `legacyIdemKeyNorm`: it feeds a
 *  persisted column under an index, so it must not change once chosen — which is the
 *  opposite requirement from `text.ts::norm`'s live callers. */
const canonicalValue = (v: unknown): string => {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalValue).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalValue(o[k])}`).join(",")}}`;
};

/**
 * The statement half of the exact-dedup key, and a FROZEN copy of what `text.ts`'s `norm`
 * happens to say today — deliberately a copy, exactly like `migrate-memory-docs.ts`'s
 * `legacyIdemKeyNorm`, and for the same reason that one exists.
 *
 * Its output is embedded in `vault_claims.normalized_hash` under `idx_vclaims_norm_hash`
 * (`schema.ts`), so a fact already recorded is recognised by matching this exact string
 * forever. `text.ts`'s `norm` answers a different question — "is this the same wording,
 * for today's search or dedup" — and its docstring explicitly frees its callers to gain
 * Unicode normalization, apostrophe folding, or anything else. This function used to BE
 * that shared `norm`, which meant the day search learned NFC every stored key would shift
 * at once: old rows would keep one key and new rows another, the exact-dedup read would
 * answer "not known" for facts that are known, and the store would start repeating itself
 * back to the person — no test failing, no error firing. Pinned by literal digests in
 * `__tests__/normalized-hash.test.ts`; if that test still passes after you "simplify" this
 * back into a shared call, it is not testing what its name says.
 */
const dedupKeyNorm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * `dedupKeyNorm(statement)` + canonical value, sha256 hex. The separator is a NEWLINE and
 * that is not arbitrary: `dedupKeyNorm` collapses every whitespace run to a single space,
 * so its output can never contain one, and `JSON.stringify` escapes newlines inside
 * strings, so neither can the right half — the two halves cannot be re-cut at a different
 * boundary, which a space or a colon would allow.
 *
 * BOTH inputs are frozen, and neither is frozen by this function. Callers hand it the
 * CLAMPED statement (`fitStatement`), which is right — the key must describe the text that
 * was actually stored — but `fitStatement` is an ordinary live function with no freeze
 * contract of its own, so moving `STATEMENT_MAX_CHARS` off 500 re-keys every long claim.
 * That drift is at least visible (the stored statement changes too), unlike a
 * `dedupKeyNorm` drift.
 *
 * Only the literal digests in `__tests__/normalized-hash.test.ts` catch either, and note
 * WHICH pin catches which: this function never calls `fitStatement`, so the short-statement
 * pins cannot see the clamp at all and a `STATEMENT_MAX_CHARS` change slips straight past
 * them. The clamp is frozen by the one pin that hashes `fitStatement(...)` of an
 * over-length literal. Exported for those tests, and for no other caller.
 */
export function normalizedHashOf(statement: string, value: unknown): string {
  return createHash("sha256").update(`${dedupKeyNorm(statement)}\n${canonicalValue(value)}`).digest("hex");
}

/** A slot is a GROUPING HINT, not an identity, and the difference is this round's
 *  correction — see the column comment in `schema.ts`. It is still clamped, because an
 *  unbounded key from extraction is a display and search problem of its own, and empty
 *  still means ABSENT rather than a slot named `""`. */
export function fitSlotKey(slotKey: string | null | undefined): string | undefined {
  return slotKey?.replace(/\s+/g, " ").trim().slice(0, SLOT_KEY_MAX_CHARS) || undefined;
}

/**
 * "A topic and the claim filed under it live in the same space." Both foreign keys
 * on `note_claims` are satisfied by a cross-space pair, so the row is accepted and
 * the other space's topic starts counting a claim it may not even be allowed to
 * show — and plan D's topic projection turns that count into leaked content.
 * Neither the schema nor a foreign key can express the invariant, so the module that
 * owns the table enforces it.
 *
 * Called from ALL THREE sites that write `note_claims` (create, the successor's
 * fallback topic, and `attachToTopic`): an unguarded fourth would mean the invariant
 * simply does not hold. Throwing rather than skipping — a caller reaching across
 * spaces is a bug, and a silently dropped attachment is a fact missing from the
 * screen with nothing to explain why.
 */
/**
 * "A retired space gains no new claims." Stands on BOTH inserts into `vault_claims`
 * rather than on the candidate ledger alone, because a rule placed on one entrance out
 * of two is how this feature has already been wrong twice: the secret screen sat on the
 * extraction path while `memory_propose` walked past it, and the provenance gate sat on
 * propose while `memory_update` walked past it. `createClaim` and `updateClaim` are the
 * only two statements that put a row in this table, so this is the whole boundary.
 *
 * `updateClaim` needs it as much as `createClaim` does, and less obviously: its
 * successor is a NEW row, and a supersede committing just after `retireProjectSpace`
 * took its DELETE snapshot leaves that successor behind — a claim alive in a space the
 * user deleted, with its predecessor gone.
 *
 * Throws rather than returning a "no". A caller reaching into a retired space skipped
 * the ledger's own check, and a silently dropped write here would be a fact the caller
 * believes it stored. The whole transaction rolls back with it, so a refused supersede
 * does not leave the predecessor superseded and unreplaced.
 *
 * CLOSED, where this used to record an accepted deadlock. `confirmCandidate` took the
 * candidate's row lock before it reached either writer, so a confirmation racing a
 * project delete could deadlock against the retire (which holds the space and wants the
 * candidate) — accepted only because no human could reach a confirm at all. Its first
 * caller changed that, and the fence it grew reads the space BEFORE the CAS, so both
 * moves now take the space row first and the candidate second.
 */
async function assertSpaceLive(spaceId: string, ex: Ex): Promise<void> {
  if (!(await spaceAcceptsWrites(spaceId, ex))) {
    throw new Error(`space ${spaceId} is retired; refusing to write a claim into it`);
  }
}

async function assertTopicInSpace(noteId: string, spaceId: string, ex: Ex): Promise<void> {
  const [note] = await ex
    .select({ spaceId: vaultNotes.spaceId })
    .from(vaultNotes)
    .where(eq(vaultNotes.id, noteId))
    .limit(1);
  if (note?.spaceId !== spaceId) {
    throw new Error(`topic ${noteId} does not belong to space ${spaceId}`);
  }
}

/** All three writing moves (`createClaim`, `updateClaim`, `forgetClaim`) touch
 *  several rows, so without a transaction they are not a move but a handful of
 *  separate statements. The `!ex || ex === db` condition is not a slip: `Ex`
 *  permits passing the module pool EXPLICITLY, and then "omitted" and "explicit
 *  db" would mean different things — silently losing atomicity on the second is
 *  exactly the defect an ordinary test cannot see. A transaction that was passed
 *  in stays the caller's: they own its boundaries. */
export async function createClaim(
  input: ClaimInput,
  actor: Actor,
  ex?: Ex,
): Promise<{ id: string; revision: number; sensitive: boolean }> {
  if (!ex || ex === db) return db.transaction((tx) => createClaim(input, actor, tx));

  // FIRST statement in the transaction, so the space row is the first lock this move
  // takes — `retireProjectSpace` takes it first too, and a shared order is what keeps
  // the two from deadlocking on each other.
  await assertSpaceLive(input.spaceId, ex);

  const id = nanoid();
  // Secret-shaped text is flagged whatever the caller said. Applied HERE rather than at
  // each writer — see `secretShaped`, and note it is handed the RAW text: it screens
  // both that and the clamped form, because truncation can remove a match as easily as
  // change one.
  const statement = fitStatement(input.statement);
  const slotKey = fitSlotKey(input.slotKey);
  const sensitive = input.sensitive || secretShaped(input.statement, input.slotKey, input.value);
  // The node row and the claim row are one write. The composite FK below runs child →
  // parent, so this has to come FIRST — and it is here rather than inside `insertNode`'s
  // caller-of-a-caller because "every subtype row is created in one transaction with its
  // node row" is a property of this statement pair, not of a convention.
  await insertNode({ id, spaceId: input.spaceId, kind: "claim" }, ex);
  await ex.insert(vaultClaims).values({
    id,
    spaceId: input.spaceId,
    statement,
    slotKey: slotKey ?? null,
    value: input.value ?? null,
    origin: input.origin,
    // `review_status` is NOT passed: it takes the column's `unverified` default, and
    // `confirmClaim` is the only thing that moves it. See `ClaimInput`.
    sensitive,
    sourceClass: input.sourceClass,
    // Armed HERE, from the class being stored, not by a caller and not by a trigger.
    expiresAt: horizonFor(input.sourceClass),
    createdTaskId: input.createdTaskId ?? null,
    normalizedHash: normalizedHashOf(statement, input.value ?? null),
  });
  if (input.topicNoteId) {
    await assertTopicInSpace(input.topicNoteId, input.spaceId, ex);
    await ex.insert(noteClaims).values({ noteId: input.topicNoteId, claimId: id });
  }
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: input.spaceId,
    actor,
    action: "claim.create",
    subjectType: "claim",
    subjectId: id,
    // No claim text: the audit log is read more widely than the space itself, and
    // `retireProjectSpace` deliberately keeps these events after it has deleted the
    // claims — so whatever rides here outlives the user's own deletion of the project.
    // `slotKey` is claim text by design (`supplier/acme/payment-terms` names the
    // supplier) and it was carried here as addressing, which it is not: `subject_id`
    // addresses the row, and while that row exists it holds the slot key itself. After
    // the retire the row is gone and there is nothing left to address — only content
    // that outlived its space, which is the one thing this line exists to prevent.
    payload: { reviewStatus: "unverified", sensitive },
  });
  // The projection is written by the same transaction that writes the row it projects.
  await projectClaimDoc(id, ex);
  // `sensitive` travels back because the screen may have RAISED it: a caller that
  // tracks the flag it asked for would otherwise be tracking a value the row does not
  // hold.
  return { id, revision: 1, sensitive };
}

export async function updateClaim(
  args: {
    claimId: string;
    expectedRevision: number;
    /** Fields not listed are inherited from the predecessor — the default, since a
     *  supersede on its own asserts nothing about the fact. `origin` is settable
     *  because when the new content arrives from a DIFFERENT source (the candidate
     *  ledger) inheriting it would sign the user's text with someone else's provenance.
     *
     *  `reviewStatus` is NOT settable, for the same reason `ClaimInput` no longer carries
     *  it: a writer must not declare its own output approved, and a supersede carrying
     *  `confirmed` across to a row with NEW text is a writer declaring exactly that. So a
     *  supersede that rewrites text is born `unverified` and the confirm path calls
     *  `confirmClaim` on it — one write grants approval, and it is the one a person
     *  triggers. A supersede that rewrites NO text carries the predecessor's status and
     *  approval record forward instead; see the insert below for why the rule is that
     *  width and not wider. */
    patch: {
      statement?: string;
      value?: unknown;
      slotKey?: string;
      sensitive?: boolean;
      origin?: Record<string, unknown>;
      /** A fallback topic, applied ONLY when no attachment carried over from the
       *  predecessor. A successor outside every topic is invisible to the note
       *  projection — but silently moving a human-curated section into the default
       *  topic would be worse than that. */
      topicNoteId?: string;
    },
    /** The REPLACEMENT's own class, and it sits outside `patch` on purpose: `patch`'s
     *  contract is "fields not listed are inherited from the predecessor", and inheriting
     *  here would carry `legacy_confirmed`/`manifest` across text the agent wrote. A
     *  superseding row is stored at the replacement's class, never the predecessor's —
     *  the same rule, and the same reason, as `reviewStatus` not being settable. */
    sourceClass: ServerClass;
    allowedSpaceIds: string[];
    actor: Actor;
  },
  ex?: Ex,
): Promise<{ ok: true; id: string; revision: number } | { ok: false; current: ClaimHead | null }> {
  if (!ex || ex === db) return db.transaction((tx) => updateClaim(args, tx));
  const { claimId, expectedRevision, patch, sourceClass, allowedSpaceIds, actor } = args;

  // The space is read UNLOCKED and ahead of the CAS purely to fix the lock ORDER:
  // `retireProjectSpace` takes the space row and then the claim rows, so a fence read
  // after the CAS would take them the other way round and the two would deadlock. A
  // claim's `space_id` never changes, so this read cannot go stale; a claim that is not
  // there (or not ours) needs no fence at all — the CAS below already answers "no".
  const [target] = await ex
    .select({ spaceId: vaultClaims.spaceId })
    .from(vaultClaims)
    .where(and(eq(vaultClaims.id, claimId), inArray(vaultClaims.spaceId, allowedSpaceIds)))
    .limit(1);
  if (target) await assertSpaceLive(target.spaceId, ex);

  // The CAS step comes FIRST: one statement takes the row lock, checks the
  // revision and checks the space, so there is no window between checking and
  // writing. A second concurrent supersede queues on this UPDATE and re-reads the
  // row after the winner commits: `superseded_at IS NULL` is false by then.
  //
  // ACCEPTED (GPT audit #12): two callers swapping each other's `patch.slotKey`
  // inside one transaction take these row locks in opposite orders and Postgres kills
  // one of them with a deadlock. Unreachable from the memory tools — none of them
  // passes `slotKey` — but this is a public service function, so it is reachable from
  // future callers. Not defended here: the fix is an ordering rule the caller has to
  // hold (touch slots in a stable order), and a lock-ordering helper in a function
  // that supersedes ONE claim would be enforcing a discipline it cannot see.
  const [prev] = await ex
    .update(vaultClaims)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(vaultClaims.id, claimId),
        eq(vaultClaims.revision, expectedRevision),
        isNull(vaultClaims.supersededAt),
        inArray(vaultClaims.spaceId, allowedSpaceIds),
      ),
    )
    .returning();

  // Zero rows means "wrong revision" OR "no longer the head" OR "not your space",
  // and telling those apart from outside is deliberately impossible: the reply is
  // built with the SAME space filter, so `current: null` reads identically for
  // "the chain was forgotten" and "no such claim exists for you".
  if (!prev) return { ok: false, current: await findCurrentHead(claimId, allowedSpaceIds, ex) };

  const id = nanoid();
  const revision = prev.revision + 1;
  // Sensitivity rises, never falls — the same rule `confirmClaim` enforces, for the
  // same reason: a caller computing `head.sensitive || x` from a head it read earlier
  // can hand back a stale `false`, and here it would be written onto the successor as
  // a plain inheritance. `prev` comes out of the CAS statement's own RETURNING, under
  // its row lock, so it is the freshest value there is.
  //
  // The successor's own text is screened too, the other half of the boundary
  // `createClaim` holds: a supersede is how NEW text enters the table, so without this
  // an ordinary claim could be rewritten into one carrying a credential and stay
  // manifest-eligible. Screening the inherited statement as well is deliberate — it
  // upgrades a row created before this screen existed.
  // Clamped and single-lined here too, and the INHERITED text is put through it as
  // well — the same reasoning as the screen below it: this upgrades a row written
  // before the rule existed, and a supersede is the one moment a legacy head's text is
  // rewritten at all.
  //
  // The slot key and the value are resolved HERE rather than inline in the insert
  // below, because the screen has to read the text the successor will actually hold —
  // the same reason the statement is clamped before it is screened. Both inherit from
  // the predecessor when the patch is silent, and the inherited text is screened too,
  // which is what upgrades a row written before this covered three columns.
  const rawStatement = patch.statement ?? prev.statement;
  const rawSlotKey = patch.slotKey ?? prev.slotKey;
  const statement = fitStatement(rawStatement);
  const slotKey = fitSlotKey(rawSlotKey) ?? null;
  const value = patch.value !== undefined ? patch.value : prev.value;
  // The RAW text goes to the screen, which answers for both forms — see `secretShaped`.
  const sensitive = prev.sensitive || (patch.sensitive ?? false) || secretShaped(rawStatement, rawSlotKey, value);
  // Does this supersede put NEW text in the table? That question, and not "was this a
  // supersede", is what decides whether approval carries across — see the insert below.
  //
  // Answered from the RESULTING ROW, never from which patch fields were supplied. A list
  // of patch field names is an enumeration, and the field somebody adds next would not be
  // on it — this feature's signature defect — and here it would fail OPEN, carrying
  // `confirmed` onto words nobody approved. The three text-bearing columns are the three
  // the model projection reads, so any patch that reaches the model is caught, including
  // one written after this line. `isDeepStrictEqual` because jsonb does not preserve key
  // order, so the same value comes back in either shape.
  const rewritesText =
    statement !== fitStatement(prev.statement) ||
    slotKey !== (fitSlotKey(prev.slotKey) ?? null) ||
    !isDeepStrictEqual(value ?? null, prev.value ?? null);
  // The successor is a fresh row, not an UPDATE of the text: the predecessor
  // stays verbatim as it was recorded. The whole claim is copied, not just the
  // three fields in the patch — otherwise `kind` and the validity window would
  // quietly reset to the schema defaults.
  //
  // The SUCCESSOR is a new row, so it is a new node. The predecessor's node is untouched:
  // a superseded claim is history, and history is not deleted (§2.10 — `superseded_at`
  // and `vault_nodes.deleted_at` are different flags with different readers).
  await insertNode({ id, spaceId: prev.spaceId, kind: "claim" }, ex);
  await ex.insert(vaultClaims).values({
    id,
    spaceId: prev.spaceId,
    statement,
    slotKey,
    value,
    kind: prev.kind,
    origin: patch.origin ?? prev.origin,
    // `review_status` is NOT settable, and it is inherited ONLY when this supersede
    // rewrites no text. When it does rewrite text the successor takes the column's
    // `unverified` default, exactly as `createClaim`'s insert does.
    //
    // Inheriting UNCONDITIONALLY was the loophole in "one write grants approval": a
    // supersede is how NEW text enters this table, so carrying `confirmed` across minted
    // model-visible words nobody had approved, without `confirmClaim` running at all.
    //
    // Demoting unconditionally was the opposite error, and a worse-costing one. The
    // argument above is about new WORDS; a topic move, a `sensitive` raise or an `origin`
    // correction brings none, and demoting there is not a temporary quarantine but a
    // one-way door: `confirmClaim`'s only callers sit inside `confirmCandidate`, which
    // needs a `memory_candidates` row, and this path creates none — so the head would
    // vanish from the model AND from the person's own memory page, present in the table
    // and reachable from no surface at all. The mechanism and the invariant it serves now
    // have the same width, which is the whole of the fix.
    //
    // The approval RECORD travels with the status it belongs to. Splitting them would
    // leave a successor reading `confirmed` with nobody named as having approved it —
    // and naming the approver is the entire reason those two columns exist.
    reviewStatus: rewritesText ? "unverified" : prev.reviewStatus,
    approvedAt: rewritesText ? null : prev.approvedAt,
    approvedByUserId: rewritesText ? null : prev.approvedByUserId,
    sensitive,
    validFrom: prev.validFrom,
    validTo: prev.validTo,
    revision,
    supersedes: claimId,
    sourceClass,
    // From the REPLACEMENT's class, never from `prev` — a successor re-arms its own
    // horizon for the same reason it does not inherit its predecessor's class.
    expiresAt: horizonFor(sourceClass),
    // `createdTaskId` IS inherited, and that is not the same decision as the class above:
    // it records which task authored the chain, not what authority the words carry, and
    // `memory_forget`'s bound asks "did I write this" — which a supersede inside the same
    // task should keep answering yes to. The CAS `.returning()` above takes no argument,
    // so `prev` is the whole row and this column comes back with it.
    createdTaskId: prev.createdTaskId,
    normalizedHash: normalizedHashOf(statement, value ?? null),
  });
  // Attachments move in a single UPDATE: the successor lands in the same topics
  // and the predecessor holds none. An insert...select plus delete would reach the
  // same state in two statements, with an order that can be got wrong.
  const moved = await ex
    .update(noteClaims)
    .set({ claimId: id })
    .where(eq(noteClaims.claimId, claimId))
    .returning({ noteId: noteClaims.noteId });
  // The predecessor was in no topic at all — inheriting "none" would make the
  // successor invisible to the note projection, so the fallback topic applies.
  if (!moved.length && patch.topicNoteId) {
    await assertTopicInSpace(patch.topicNoteId, prev.spaceId, ex);
    await ex.insert(noteClaims).values({ noteId: patch.topicNoteId, claimId: id });
  }
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: prev.spaceId,
    actor,
    action: "claim.supersede",
    subjectType: "claim",
    subjectId: claimId,
    // The SUCCESSOR's state, not the patch: otherwise the event would assert a
    // change where a field was merely inherited. No text — the audit is read wider.
    payload: {
      successor: id,
      revision,
      // The successor's OWN status, computed the same way the insert computes it: a
      // supersede that rewrote text does not carry approval across, and the event must
      // not say it did — nor say the opposite when nothing was rewritten.
      reviewStatus: rewritesText ? "unverified" : prev.reviewStatus,
      sensitive,
    },
  });
  // The SUCCESSOR only. The predecessor's row is untouched by a supersede — `updateClaim`
  // writes it `superseded_at` and nothing else, and its own comment says so ("the
  // predecessor stays verbatim as it was recorded"); the re-clamping and re-screening
  // happen on the SUCCESSOR's values. Since this table holds no lifecycle state, the
  // predecessor's projection row is still correct, and it is the mint's join that stops
  // it from being returned.
  await projectClaimDoc(id, ex);
  return { ok: true, id, revision };
}

/** Forgetting takes no `reason`, and the absence is deliberate. It used to accept
 *  model-authored free text and write it into the audit payload, where — because
 *  `retireProjectSpace` keeps these events after deleting the claims — a sentence
 *  restating the very fact being forgotten outlived the user's deletion of the
 *  project. It was not addressing either: the event already names the claim, the
 *  revision, the actor and the moment. A paraphrase written by the model is thin
 *  evidence at the best of times, and it is not worth retaining past a delete.
 *
 *  Whoever wants "why" on a deletion should take it from the human doing the
 *  deleting, on plan D's own screen, and answer the retention question there. */
export async function forgetClaim(
  args: { claimId: string; expectedRevision: number; allowedSpaceIds: string[]; actor: Actor },
  ex?: Ex,
): Promise<{ ok: true } | { ok: false; current: ClaimHead | null }> {
  if (!ex || ex === db) return db.transaction((tx) => forgetClaim(args, tx));
  const { claimId, expectedRevision, allowedSpaceIds, actor } = args;

  const [prev] = await ex
    .update(vaultClaims)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(vaultClaims.id, claimId),
        eq(vaultClaims.revision, expectedRevision),
        isNull(vaultClaims.supersededAt),
        inArray(vaultClaims.spaceId, allowedSpaceIds),
      ),
    )
    .returning({ spaceId: vaultClaims.spaceId, revision: vaultClaims.revision });
  if (!prev) return { ok: false, current: await findCurrentHead(claimId, allowedSpaceIds, ex) };

  // N10: the SAME terminal state as `forgetAllClaims`. Round 1 gave this obligation to
  // the bulk path only, so "forget this fact" left its edges live and its projection row
  // in place while "forget everything" removed both — one user-facing act with two
  // terminal states. Through the node module, never a bare `db.update`: the edge cascade
  // lives with it.
  await deleteNode(claimId, prev.spaceId, ex);

  // No successor — "forgotten" IS a chain with no active head. `note_claims` and
  // `claim_evidence` stay on the inactive row: forgetting a fact does not mean
  // rewriting where it came from.
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: prev.spaceId,
    actor,
    action: "claim.forget",
    subjectType: "claim",
    subjectId: claimId,
    payload: { revision: prev.revision },
  });
  return { ok: true };
}

/**
 * "Forget everything" for one space, and it lives here because `forgetClaim` does: the
 * module that owns `vault_claims` owns every way out of it, and a bulk `db.delete` from
 * a route would skip the audit trail that makes the deletion visible afterwards.
 *
 * FORGETS, it does not DELETE. Every live head is superseded — the same terminal state
 * one forget produces — so the rows, their evidence and their topic attachments stay as
 * they were and the audit log can still name what was removed. A DELETE would leave
 * `audit_events` pointing at subject ids that no longer resolve, which is the artifact
 * N-3 warns about from the other direction: a log that records that something happened
 * and cannot say what.
 *
 * Takes every live head, NOT only the confirmed ones the memory page renders. An
 * unverified head is invisible on that page and is still a recorded claim in the space,
 * and leaving it behind would mean a later confirmation resurrects a fact the person
 * believed they had erased. So the count returned is a count of rows and not of the facts
 * that were on screen — which is why nothing shows it to the user.
 *
 * The review queue is deliberately NOT swept here. `memory_candidates` is
 * `candidates.ts`'s table and `rejectAllCandidates` is its inverse; a function named for
 * claims quietly resolving candidates is the same altitude slip this module's own rules
 * are written against. The route runs the two inside one transaction per space.
 */
export async function forgetAllClaims(spaceId: string, actor: Actor, ex?: Ex): Promise<{ forgotten: number }> {
  if (!ex || ex === db) return db.transaction((tx) => forgetAllClaims(spaceId, actor, tx));

  const heads = await ex
    .update(vaultClaims)
    .set({ supersededAt: new Date() })
    .where(and(eq(vaultClaims.spaceId, spaceId), isNull(vaultClaims.supersededAt)))
    .returning({ id: vaultClaims.id, revision: vaultClaims.revision });
  // Drizzle rejects an empty VALUES list outright, and a space with nothing in it is the
  // ordinary case for every scope the person never used.
  if (!heads.length) return { forgotten: 0 };

  // A loop rather than one statement: `deleteNode` owns the pair of writes, and
  // open-coding the bulk form here would be a second implementation of the inverse —
  // the exact split N10 records.
  for (const head of heads) await deleteNode(head.id, spaceId, ex);

  // One multi-row INSERT rather than a statement per head: this is a sweep over a whole
  // space, and a round trip per fact would scale with exactly the thing that makes
  // someone reach for this button.
  await ex.insert(auditEvents).values(
    heads.map((head) => ({
      id: nanoid(),
      spaceId,
      actor,
      action: "claim.forget",
      subjectType: "claim",
      subjectId: head.id,
      // The same payload one forget writes: no text, because the audit log is read more
      // widely than the space itself. `bulk` is the one addition, and it earns its place
      // by telling a reset apart from a person deleting facts one at a time — without it
      // the trail of a single click is indistinguishable from a hundred deliberate ones.
      payload: { revision: head.revision, bulk: true },
    })),
  );
  return { forgotten: heads.length };
}

/**
 * THE write that grants authority. Since the cutover this is the only statement in the
 * codebase that can turn unapproved words into approved ones, and its only caller is the
 * human's decision on the memory page — so "the model reads only what a person
 * approved" is a property of there being one such write, not of every writer choosing
 * the right value.
 *
 * One other statement can leave a row reading `confirmed`: `updateClaim`'s successor
 * carries the predecessor's status when it rewrote no text. It grants nothing — the words
 * and the approval are the ones that were already paired — and the alternative was
 * demoting a head that no surface can re-approve.
 *
 * `approved_at` / `approved_by_user_id` are written here for the same reason.
 * `review_status = 'confirmed'` records THAT something was approved and cannot say by
 * whom, which is the whole claim being made. The actor is the one this move is
 * performed as; an agent or system actor leaves `approved_by_user_id` NULL rather than
 * inventing an approver.
 *
 * `superseded_at IS NULL` is in the predicate, and that is N1. This used to update
 * `WHERE id = $1` alone: its own comment argued carefully that sensitivity must be
 * OR-ed in SQL because a head read earlier goes stale, and then omitted the other half
 * of exactly that argument — the ROW may have stopped being a head between the read and
 * this write. When a supersede commits inside that window the confirmation and the
 * raised `sensitive` land on a dead version while the live head carries neither, and
 * `memory_candidates.claim_id` is left pointing at a claim that is no longer current,
 * so the page's own link from a decision to its fact goes to the wrong version.
 *
 * It RETURNS whether the update hit, and the miss must not be discarded. A `void`
 * return is what let the defect through: the write silently affected zero rows and the
 * caller carried on as though it had worked. `tsc` cannot force a caller to read a
 * boolean — there is no must-use in TypeScript — so this is a single-call-site
 * discipline rather than a compile-time one, and that is recorded here rather than
 * implied.
 *
 * Sensitivity only ever goes up, and the OR is done in SQL rather than left to the
 * caller's `head.sensitive || …`: that expression is computed from a head read earlier,
 * so two confirmations of the same head — one sensitive, one not — would let the stale
 * `false` land second. Clearing sensitivity is deliberate work; it needs its own
 * operation, and there is no site for one today.
 *
 * Lives in this module rather than the candidate ledger for the same reason as the
 * rest: `vault_claims` is written only by whoever owns it. There is deliberately no
 * space filter — like `attachEvidence`, this takes an id JUST read by a space-scoped
 * query. It writes no event: the confirmation is recorded by `candidate.confirm` on the
 * ledger side.
 */
export async function confirmClaim(
  claimId: string,
  sensitive: boolean,
  actor: Actor,
  ex?: Ex,
): Promise<boolean> {
  // TWO statements now, not one — the flip and the re-projection — so without a
  // transaction this stopped being a move and became a pair of autocommits: a crash
  // between them leaves a confirmed, possibly newly-sensitive head whose search document
  // still carries the OLD `model_text`, which is a withheld statement left matchable in
  // the model lane. The `!ex || ex === db` shape is the one `getOrCreateTopicNote`
  // documents: `Ex` permits passing the pool explicitly, and "omitted" and "explicit db"
  // must not mean different things.
  //
  // There is deliberately NO atomicity witness beside the one `insertNode` has. That test
  // needs a failure injected BETWEEN the two writes, and nothing here can supply one: the
  // projection's only statement is an upsert into a table with no constraint a fixture can
  // violate, so the witness would need either a module-level mock of `search-documents`
  // across the whole claims suite or a trigger on a table the live dev worker also writes.
  // Recorded rather than left as an unexplained gap.
  if (!ex || ex === db) return db.transaction((tx) => confirmClaim(claimId, sensitive, actor, tx));
  const hit = await ex
    .update(vaultClaims)
    .set({
      reviewStatus: "confirmed",
      sensitive: sql`${vaultClaims.sensitive} OR ${sensitive}`,
      approvedAt: new Date(),
      approvedByUserId: actor.kind === "user" ? (actor.id ?? null) : null,
    })
    .where(and(eq(vaultClaims.id, claimId), isNull(vaultClaims.supersededAt)))
    .returning({ id: vaultClaims.id });
  // Only when it HIT: a confirmation can RAISE `sensitive`, which is exactly the
  // owner-side change §2.8 says a denormalized channel column would miss — and `hit` is
  // the `.returning()` ARRAY, so `if (hit)` would be true on a missed CAS too and would
  // re-project a row the confirmation never landed on.
  if (hit.length) await projectClaimDoc(claimId, ex);
  return hit.length > 0;
}

/** Attach an EXISTING head to a topic, without a new version: when the statement
 *  the caller brings matched a fact already recorded there is no content to
 *  change — but a fact sitting outside every topic is invisible to the note
 *  projection, which means it does not exist for the UI. Idempotent via
 *  `uniq_note_claims`.
 *
 *  This ADDS a topic, it does not move one: a human-curated section stays where
 *  it is (unlike the fallback topic in `updateClaim`, which applies only when no
 *  attachment survived at all). Lives in this module for the same reason as
 *  `confirmClaim`: `note_claims` is written only by whoever owns it. */
export async function attachToTopic(claimId: string, noteId: string, ex: Ex = db): Promise<void> {
  // The claim's space has to be read: unlike the other two sites, this signature
  // carries only the two ids, and the invariant is about the pair.
  const [claim] = await ex
    .select({ spaceId: vaultClaims.spaceId })
    .from(vaultClaims)
    .where(eq(vaultClaims.id, claimId))
    .limit(1);
  if (!claim) throw new Error(`claim ${claimId} does not exist`);
  await assertTopicInSpace(noteId, claim.spaceId, ex);
  await ex.insert(noteClaims).values({ noteId, claimId }).onConflictDoNothing();
}

export async function attachEvidence(claimId: string, ev: EvidenceInput, ex: Ex = db): Promise<void> {
  await ex.insert(claimEvidence).values({
    id: nanoid(),
    claimId,
    relation: ev.relation ?? "supports",
    fragmentId: ev.fragmentId ?? null,
    messageId: ev.messageId ?? null,
    quoteSnapshot: ev.quoteSnapshot ?? null,
    locatorSnapshot: ev.locatorSnapshot ?? null,
  });
}

export async function listHeadClaims(
  spaceId: string,
  opts: { slotKey?: string; topicNoteId?: string; onlyConfirmed?: boolean } = {},
  ex: Ex = db,
): Promise<ClaimHead[]> {
  return ex
    .select(HEAD)
    .from(vaultClaims)
    .where(
      and(
        eq(vaultClaims.spaceId, spaceId),
        isNull(vaultClaims.supersededAt),
        opts.slotKey ? eq(vaultClaims.slotKey, opts.slotKey) : undefined,
        opts.onlyConfirmed ? eq(vaultClaims.reviewStatus, "confirmed") : undefined,
        // The subquery is not run separately — drizzle inlines its SQL into this
        // same statement, so it rides the same `ex` as the outer SELECT.
        opts.topicNoteId
          ? inArray(
              vaultClaims.id,
              ex.select({ id: noteClaims.claimId }).from(noteClaims).where(eq(noteClaims.noteId, opts.topicNoteId)),
            )
          : undefined,
      ),
    )
    // The second key is not decorative: `recorded_at` is identical across every
    // claim one transaction wrote, and without `id` their order would be arbitrary.
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
}

/** The most recent live claim filed under one slot key.
 *
 *  "The" head is a convenience, not a guarantee, and that changed in this round.
 *  `uniq_vclaims_active_slot` used to make the slot an identity; live data disproved
 *  the premise — the model invents a fresh key per turn (`user/pet` one turn,
 *  `user/pets/cat` the next), so the index constrained bytes while the thing it was
 *  built to constrain was meaning. With it dropped, two live claims may share a key, so
 *  the ORDER is explicit rather than whatever the planner returns: newest first, `id`
 *  breaking a tie between rows one transaction wrote. */
export async function headBySlot(spaceId: string, slotKey: string, ex: Ex = db): Promise<ClaimHead | null> {
  const [row] = await ex
    .select(HEAD)
    .from(vaultClaims)
    .where(
      and(eq(vaultClaims.spaceId, spaceId), eq(vaultClaims.slotKey, slotKey), isNull(vaultClaims.supersededAt)),
    )
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id))
    .limit(1);
  return row ?? null;
}

/** Walks FORWARD along the chain: from the given claim, following `supersedes`,
 *  to the last row. If that row carries `superseded_at` the chain was ended by a
 *  forget and there is no head. `allowedSpaceIds` filters every step, so another
 *  space does not even leak the chain's length; the mismatch protocol in
 *  update/forget passes exactly the list the CAS step used.
 *
 *  The argument is REQUIRED even though it accepts `undefined`: in a module whose
 *  entire point is keeping spaces apart, the shorter call has to be the safe one.
 *  Made optional, a forgotten argument would hand back the head from ANY space,
 *  text included — with no type error and no red test. As it stands, an unscoped
 *  read is a visible decision at the call site (`undefined`), not an omission. */
export async function findCurrentHead(
  claimId: string,
  allowedSpaceIds: string[] | undefined,
  ex: Ex = db,
): Promise<ClaimHead | null> {
  // `inArray` with an empty list yields `false` — "no spaces" reads as "nothing is
  // visible", never as "everything".
  const scope = allowedSpaceIds ? inArray(vaultClaims.spaceId, allowedSpaceIds) : undefined;
  const select = (where: ReturnType<typeof eq>) =>
    ex
      .select({ ...HEAD, supersededAt: vaultClaims.supersededAt })
      .from(vaultClaims)
      .where(and(where, scope))
      .limit(1);

  const [start] = await select(eq(vaultClaims.id, claimId));
  if (!start) return null;

  let row = start;
  for (let hops = 0; ; hops++) {
    if (hops > MAX_CHAIN) throw new Error(`claim chain from ${claimId} does not terminate`);
    const [next] = await select(eq(vaultClaims.supersedes, row.id));
    if (!next) break;
    row = next;
  }
  const { supersededAt, ...head } = row;
  return supersededAt ? null : head;
}
