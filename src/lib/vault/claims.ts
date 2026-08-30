import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, claimEvidence, noteClaims, vaultClaims, vaultNotes } from "@/lib/db/schema";
import { spaceAcceptsWrites, type Ex } from "./spaces";

export type Actor = { kind: "user" | "agent" | "system"; id?: string };

export type ClaimHead = {
  id: string;
  revision: number;
  statement: string;
  slotKey: string | null;
  value: unknown;
  reviewStatus: string;
  sensitive: boolean;
};

export type ClaimInput = {
  spaceId: string;
  statement: string;
  slotKey?: string;
  value?: unknown;
  origin: Record<string, unknown>;
  reviewStatus: "unverified" | "confirmed";
  sensitive?: boolean;
  topicNoteId?: string;
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
};

/** The version chain cannot cycle: `uniq_vclaims_one_successor` allows at most
 *  one successor and a successor is always newer. But an unbounded `while` over
 *  data is how a service hangs, so the bound is explicit. */
const MAX_CHAIN = 1000;

/**
 * Screens a statement for secret-shaped content. It lives in THIS module because
 * `createClaim` and `updateClaim` are the only two statements that put a row in
 * `vault_claims`, so a screen applied by both covers every writer by construction —
 * the ledger, the boot migration, and whatever a later plan adds without reading any
 * of this.
 *
 * It has been at the wrong altitude twice. First on the extraction path, where
 * `memory_propose` walked past it: the user pastes a key and says "remember it", so
 * the statement is verbatim in their own turn, provenance verifies, and the fact went
 * in `auto_active`. Then at the candidate ledger, under a docstring calling the ledger
 * "the only way into memory" — which `migrate-memory-docs.ts` disproved by calling
 * `createClaim` directly, carrying a legacy bullet reading `my openai key is sk-…`
 * into a confirmed, non-sensitive claim at boot, unattended, on data that predates
 * every protection here. The rule now sits on the table's own boundary, which is the
 * one place a fifth writer cannot appear behind.
 *
 * The ledger still runs it separately, and that is not a duplicate guard: it needs the
 * answer BEFORE any row exists, to route the proposal to `pending` instead of
 * activating it. This screen decides the COLUMN; that one decides the ROUTE.
 *
 * Tuned toward catching, not toward precision: a false positive costs one fact that a
 * human must handle; a false negative costs a durably re-injected credential.
 *
 * It has also been at the wrong COLUMN. Both writers ran it on `statement` alone,
 * while `slot_key` is printed verbatim to the model by `memory_search` (`tools.ts`)
 * and matched against its query — so a credential in the key with a clean sentence
 * produced a non-sensitive claim that hands the key back on every later search. Both
 * writers now screen all three text-bearing columns of the row they are about to
 * write: `statement`, `slot_key` and `value`. `value` has no reader today, and "no
 * reader today" is exactly the reasoning that left the quarantine filter off
 * `memory_search` for a whole plan. The other two columns are paths, not prose, and
 * are screened accordingly — see `pathishSecret`.
 */
/** Patterns that recognize a credential by its OWN prefix or structure, so they say
 *  the same thing about any text they are pointed at. */
const NAMED_SECRET_PATTERNS: RegExp[] = [
  // Provider-prefixed tokens: OpenAI (sk-), GitHub (ghp_/gho_), Slack (xoxb-/xoxp-/xoxa-/xoxs-), AWS access key id.
  // Widened to `[A-Za-z0-9_-]` (not just alphanumeric) with a 20-char floor:
  // modern OpenAI project keys are internally hyphenated (`sk-proj-AbCdEf...`), and
  // a narrower class would miss that shape entirely while the older `sk-...` form
  // still clears the same floor.
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[po]_[A-Za-z0-9]{10,}\b/,
  /\bxox[bpas]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[A-Z0-9]{12,}\b/,
  // A PEM private-key block header.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A URI with inline credentials: scheme://user:pass@host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  // An assignment whose key names a secret and whose value is non-trivial.
  /\b(password|passwd|secret|token|api[-_]?key|authorization)\s*[:=]\s*['"]?[^\s'"]{4,}['"]?/i,
];

/** Catch-all: a long unbroken base64/hex-ish run — deliberately EXCLUDING `-` from
 *  the class. Including it (an earlier version of this pattern did) also matched
 *  ordinary hyphenated things an office user states as plain fact — a URL slug, a
 *  preview-deploy hostname, a UUID — which this screen must not swallow (a screened
 *  item goes `sensitive`, which hides it from the manifest AND from search, so a false
 *  positive is a fact the user can no longer reach through the agent at all). A 40-char
 *  hex commit sha, a bare base64 token, and a `github_pat_...` fine-grained PAT all
 *  still clear the floor without a hyphen.
 *
 *  Unlike the named patterns above, this one is an ENTROPY guess, and what makes the
 *  guess safe is that a statement is prose: an unbroken 28-character run of that class
 *  is anomalous in a sentence. It is not anomalous in a path — see `pathishSecret`. */
const OPAQUE_RUN = /\b[A-Za-z0-9+/_]{28,}={0,2}\b/;

export function looksLikeSecret(statement: string): boolean {
  return NAMED_SECRET_PATTERNS.some((re) => re.test(statement)) || OPAQUE_RUN.test(statement);
}

/**
 * The same screen for text that is a PATH rather than prose: a slot key, and the JSON
 * of a structured value.
 *
 * `looksLikeSecret` unchanged is the wrong tool for those, and the repo's own fixture
 * proved it: `/` and `_` are in the catch-all's character class, which is exactly what
 * a slot key is made of, so `suppliers/acme_corp/payment_terms` is 33 characters of
 * pure match and the screen fires on the DESIGN. That is not the rare false positive
 * the statement screen accepts — it is systematic for any key of that length without a
 * hyphen, and each one costs a fact hidden from the manifest, hidden from search, and
 * (see `memory_forget`) impossible for the agent to remove afterwards.
 *
 * So the named patterns still read the whole text — `postgresql://u:p@h` and
 * `ghp_…` must not be split apart to be recognized — and the entropy guess is made per
 * path SEGMENT, where a long opaque run means what it meant in prose. Depth stops
 * being evidence of anything.
 *
 * ACCEPTED: a single segment of 28+ unbroken characters is still screened, so a slot
 * key like `annual_supplier_payment_schedule` goes sensitive. Narrower than what it
 * replaces, and left in place deliberately — that shape is also what a bare,
 * unprefixed token looks like, and this screen is tuned toward catching.
 */
function pathishSecret(text: string): boolean {
  return NAMED_SECRET_PATTERNS.some((re) => re.test(text)) || text.split("/").some((seg) => OPAQUE_RUN.test(seg));
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

/** The screen over a whole row, in ONE definition. Three call sites — both claim
 *  writers and the candidate ledger — and they must not drift: the writers decide the
 *  COLUMN and the ledger decides the ROUTE, so a column screened by one and not the
 *  other gives two answers to the same text. That is how a credential in a slot key
 *  used to route `auto_active` and then be written sensitive: stored-but-invisible,
 *  where a credential in the statement is never stored at all. */
export function secretShaped(statement: string, slotKey: string | null | undefined, value: unknown): boolean {
  return looksLikeSecret(statement) || pathishSecret(slotKey ?? "") || pathishSecret(valueText(value));
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

/** A slot is an identity, not prose: it is the key of `uniq_vclaims_active_slot`, and
 *  an unbounded one from extraction fails the btree insert outright. Empty is ABSENT,
 *  which is `proposeCandidate`'s rule for it (`""` is non-NULL, so it would be a full
 *  participant in that unique index) — held here so both claim writers share it. */
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
  // Secret-shaped text is sensitive whatever the caller said. Applied HERE rather
  // than at each writer — see `looksLikeSecret`. What it means differs by caller and
  // both outcomes are wanted: a ledger proposal never reaches this line sensitive
  // (its own screen sent it to pending first), while the boot migration creates
  // `confirmed` claims directly, so a legacy bullet holding a credential lands
  // confirmed AND sensitive. That combination is deliberate: it stays out of the
  // manifest and out of `memory_search`, which is exactly where a credential the user
  // pasted into a memory document years ago should be — carried across so nothing is
  // lost, and reachable only by the user, never re-injected by us.
  // Clamped and single-lined before it is screened, so the screen reads exactly the
  // text the row will hold — see `fitStatement`.
  const statement = fitStatement(input.statement);
  const slotKey = fitSlotKey(input.slotKey);
  const sensitive = input.sensitive || secretShaped(statement, slotKey, input.value);
  // A slot conflict (`uniq_vclaims_active_slot`) is deliberately NOT caught here:
  // the merge-or-branch decision belongs to the candidate ledger, which is also
  // the thing holding the SAVEPOINT.
  await ex.insert(vaultClaims).values({
    id,
    spaceId: input.spaceId,
    statement,
    slotKey: slotKey ?? null,
    value: input.value ?? null,
    origin: input.origin,
    reviewStatus: input.reviewStatus,
    sensitive,
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
    payload: { reviewStatus: input.reviewStatus, sensitive },
  });
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
     *  supersede on its own asserts nothing about the fact. But when the new content
     *  arrives from a DIFFERENT source (the candidate ledger), inheriting `origin`
     *  would sign the user's text with someone else's provenance, and inheriting
     *  `reviewStatus` would leave a just-confirmed fact `unverified`. So both are
     *  settable here, rather than read off the row by the caller or patched in by a
     *  separate UPDATE that goes around this module. */
    patch: {
      statement?: string;
      value?: unknown;
      slotKey?: string;
      reviewStatus?: "unverified" | "confirmed";
      sensitive?: boolean;
      origin?: Record<string, unknown>;
      /** A fallback topic, applied ONLY when no attachment carried over from the
       *  predecessor. A successor outside every topic is invisible to the note
       *  projection — but silently moving a human-curated section into the default
       *  topic would be worse than that. */
      topicNoteId?: string;
    },
    allowedSpaceIds: string[];
    actor: Actor;
  },
  ex?: Ex,
): Promise<{ ok: true; id: string; revision: number } | { ok: false; current: ClaimHead | null }> {
  if (!ex || ex === db) return db.transaction((tx) => updateClaim(args, tx));
  const { claimId, expectedRevision, patch, allowedSpaceIds, actor } = args;

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
  const statement = fitStatement(patch.statement ?? prev.statement);
  const slotKey = fitSlotKey(patch.slotKey ?? prev.slotKey) ?? null;
  const value = patch.value !== undefined ? patch.value : prev.value;
  const sensitive = prev.sensitive || (patch.sensitive ?? false) || secretShaped(statement, slotKey, value);
  // The successor is a fresh row, not an UPDATE of the text: the predecessor
  // stays verbatim as it was recorded. The whole claim is copied, not just the
  // three fields in the patch — otherwise `kind` and the validity window would
  // quietly reset to the schema defaults.
  //
  // As in `createClaim`, a slot conflict (`uniq_vclaims_active_slot`) is NOT caught
  // here: a `patch.slotKey` pointing at a taken slot raises 23505 and rolls back
  // the caller's transaction just the same. The candidate ledger has to hold its
  // SAVEPOINT around BOTH moves, not only around creation.
  await ex.insert(vaultClaims).values({
    id,
    spaceId: prev.spaceId,
    statement,
    slotKey,
    value,
    kind: prev.kind,
    origin: patch.origin ?? prev.origin,
    reviewStatus: patch.reviewStatus ?? prev.reviewStatus,
    sensitive,
    validFrom: prev.validFrom,
    validTo: prev.validTo,
    revision,
    supersedes: claimId,
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
      reviewStatus: patch.reviewStatus ?? prev.reviewStatus,
      sensitive,
    },
  });
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

/** Mark an EXISTING head confirmed, without a supersede: when the user's
 *  statement matched what is already recorded, the content did not change — only
 *  the fact that it is now confirmed did, and a new version would be empty.
 *
 *  Sensitivity only ever goes up, and the OR is done in SQL rather than left to the
 *  caller's `head.sensitive || ...`: that expression is computed from a head read
 *  earlier, so two confirmations of the same head — one sensitive, one not — let the
 *  stale `false` land second and put a claim a human closed back into the manifest.
 *  A blind update has no CAS to notice, so the rule has to be a property of the
 *  write. Clearing sensitivity is deliberate work; it needs its own operation, and
 *  there is no site for one today.
 *
 *  Lives in this module rather than the candidate ledger for the same reason as
 *  the rest: `vault_claims` is written only by whoever owns it. There is
 *  deliberately no space filter — like `attachEvidence`, this takes an id JUST
 *  read by a space-scoped query, and a filter here would mimic a check the
 *  signature has nothing to perform it with. It writes no event: the confirmation
 *  is recorded by `candidate.confirm`/`candidate.propose` on the ledger side. */
export async function confirmClaim(claimId: string, sensitive: boolean, ex: Ex = db): Promise<void> {
  await ex
    .update(vaultClaims)
    .set({ reviewStatus: "confirmed", sensitive: sql`${vaultClaims.sensitive} OR ${sensitive}` })
    .where(eq(vaultClaims.id, claimId));
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

export async function headBySlot(spaceId: string, slotKey: string, ex: Ex = db): Promise<ClaimHead | null> {
  const [row] = await ex
    .select(HEAD)
    .from(vaultClaims)
    .where(
      and(eq(vaultClaims.spaceId, spaceId), eq(vaultClaims.slotKey, slotKey), isNull(vaultClaims.supersededAt)),
    )
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
