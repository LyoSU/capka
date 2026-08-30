import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { vaultClaims } from "@/lib/db/schema";
import { fitSlotKey, fitStatement, type ClaimHead } from "./claims";
import type { Ex } from "./spaces";

/**
 * THE one route from stored text to the model.
 *
 * `recentFacts` (the system-prompt manifest) and `memory_search` each used to carry their
 * own copy of the head/confirmed/not-sensitive predicate, and `mismatch` a third in
 * JavaScript. That is this feature's recurring defect in its purest form — a rule at one
 * entrance while a second walks past it — and it has now produced twelve instances, the
 * eleventh being a fifth reader that an enumeration built from one accessor's call sites
 * simply did not contain. So the predicate is not written down four times; it is written
 * here, and a reader that wants claim text for a prompt has to come through this module.
 *
 * WHAT THE PREDICATE IS, and why each half is in it:
 *
 *  - `superseded_at IS NULL` — only a head is a fact; a predecessor is history.
 *  - `review_status = 'confirmed'` — quarantine. Since the authority cutover nothing
 *    GRANTS `confirmed` except `confirmClaim`, and its only caller is the human's
 *    confirm on the memory page. So this clause is what makes "the model sees only what
 *    a person approved" a property of the query rather than a claim in a comment. (A
 *    supersede's successor can be born `confirmed` too, but only by carrying across an
 *    approval on text it did not change — see `updateClaim`.)
 *  - `sensitive = false` — withholding from the MODEL. It never withholds from the
 *    authenticated owner: that surface is `memory-page.ts`, which deliberately does not
 *    use this module.
 *
 * There is no space clause: every caller supplies its own `spaceId`, and a projection
 * that guessed the scope would be answering a question it was not asked.
 */
export function modelVisible() {
  return and(
    isNull(vaultClaims.supersededAt),
    eq(vaultClaims.reviewStatus, "confirmed"),
    eq(vaultClaims.sensitive, false),
  );
}

declare const modelText: unique symbol;

/**
 * A string this module has decided the model may read.
 *
 * The brand is the second half of the boundary, and it is what makes a bypass fail
 * `tsc` rather than fail review: the model-facing formatters (`line` in `tools.ts`, the
 * manifest's fact lines, the lost-CAS sentence) accept `ModelText` and nothing else, so
 * a future reader that pulls a statement off `listHeadClaims` and prints it does not
 * compile. It is the same trick `StatementView` plays on the human surface, for the
 * mirror-image audience.
 *
 * The guarantee is real but not absolute — `x as ModelText` is still available to
 * somebody who writes it deliberately. `model-view.test.ts` is what catches that.
 */
export type ModelText = string & { readonly [modelText]: true };

const mint = (s: string) => s as ModelText;

/** One head as the model may see it. `value` is not model-facing text and is not
 *  branded: it rides along because the ledger's "is this already known" comparison has
 *  to read it, and that comparison must ask the same question this projection answers,
 *  not a wider one. */
export type ModelClaim = {
  id: string;
  revision: number;
  statement: ModelText;
  slotKey: ModelText | null;
  value: unknown;
};

/** Clamped and single-lined at the projection, not only at the writers. A row recorded
 *  before `fitStatement` existed still renders into a prompt, and the manifest's `- «…»`
 *  fence is built for one bounded line. Doing it HERE means every model-facing reader
 *  gets it, including the next one. */
function project(row: {
  id: string;
  revision: number;
  statement: string;
  slotKey: string | null;
  value: unknown;
}): ModelClaim {
  const slot = fitSlotKey(row.slotKey);
  return {
    id: row.id,
    revision: row.revision,
    statement: mint(fitStatement(row.statement)),
    slotKey: slot ? mint(slot) : null,
    value: row.value,
  };
}

/** Every claim in one space that the model may read, newest first. The second order key
 *  is not decorative: `recorded_at` is identical across every claim one transaction
 *  wrote, and the manifest has to be byte-identical across turns. */
export async function listModelClaims(spaceId: string, ex: Ex = db): Promise<ModelClaim[]> {
  const rows = await ex
    .select({
      id: vaultClaims.id,
      revision: vaultClaims.revision,
      statement: vaultClaims.statement,
      slotKey: vaultClaims.slotKey,
      value: vaultClaims.value,
    })
    .from(vaultClaims)
    .where(and(eq(vaultClaims.spaceId, spaceId), modelVisible()))
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
  return rows.map(project);
}

/**
 * The same decision for a head the caller ALREADY read — the lost-CAS reply of
 * `memory_update`, whose head comes from `findCurrentHead` because that function has to
 * answer "does this chain exist" whatever the head's status is.
 *
 * `null` means "not for the model", and the caller prints nothing rather than choosing
 * its own filter. Withheld for a sensitive head and for a quarantined one alike: a lost
 * CAS must not become a second way to read out what the manifest hides.
 */
export function modelTextOf(head: ClaimHead): ModelText | null {
  if (head.sensitive || head.reviewStatus !== "confirmed") return null;
  return mint(fitStatement(head.statement));
}

/**
 * How many confirmed heads this space holds that the model may NOT read.
 *
 * Query-independent by construction, which is the whole point of the sentence
 * `memory_search` builds from it: withholding a statement while still matching on it is
 * not withholding — a hit for `memory_search("diagnosis")` confirms the category the
 * withholding exists to protect. An aggregate, so no row limit can silently make it
 * look smaller than it is.
 */
export async function countWithheld(spaceId: string, ex: Ex = db): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(vaultClaims)
    .where(
      and(
        eq(vaultClaims.spaceId, spaceId),
        isNull(vaultClaims.supersededAt),
        eq(vaultClaims.reviewStatus, "confirmed"),
        eq(vaultClaims.sensitive, true),
      ),
    );
  return row?.n ?? 0;
}
