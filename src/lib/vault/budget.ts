/**
 * WHAT THE VAULT MAY SPEND OF ONE TURN'S CONTEXT.
 *
 * Memory and document results ride in the turn's own prompt, so their size is not a
 * display concern but a cost: every byte a tool hands back is re-sent on every later step
 * of the same tool-calling loop. The ceiling is therefore per TURN and shared across all
 * of the vault's tools — a per-call cap alone lets twenty calls spend twenty times.
 */

/** Measured, not assumed: prose in this repo's own contexts runs >= 4.2 bytes per token
 *  (see the token-divisor measurement), so a byte budget divided by this is the honest
 *  token figure. Dividing by 4 understated it. */
export const BYTES_PER_TOKEN = 4.2;

/** Per-call caps. They exist BESIDE the turn ceiling rather than instead of it: one call
 *  must not be able to eat the whole turn's allowance in a single answer. */
export const MEMORY_SEARCH_MAX_RESULTS = 20;
export const MEMORY_SEARCH_MAX_BYTES = 8_400;

/**
 * ONE PAGE of `memory_open`, in UTF-8 BYTES — and the unit is the whole of this name.
 *
 * §4.3 spells the parameter `max_chars`, which is the unit this file's own ceiling rejected
 * for the reason `emit` states one line down: a Ukrainian answer is two bytes per character,
 * so a character count grants a Cyrillic turn twice the context an English one gets. A page
 * measured in characters and spent against a ceiling measured in bytes is two units for one
 * quantity, which is how a budget stops bounding anything.
 *
 * The wire parameter is therefore `max_bytes` as well: naming it `max_chars` while measuring
 * bytes would be a lie told to the only reader who cannot check it.
 *
 * A page boundary never splits a UTF-8 sequence — see `read-tools.ts`, which snaps the cut
 * down to a character boundary and refuses a cursor that does not sit on one.
 */
export const MEMORY_OPEN_MAX_BYTES = 8_000;

/**
 * THE EDIT REPLY'S SNIPPET, in UTF-8 BYTES — a quarter of a `memory_open` page.
 *
 * It exists because the turn ceiling is STICKY: once one reply does not fit, every later
 * vault call in the turn gets the exhausted sentence instead of an answer. An edit's snippet
 * is the one body-bearing reply that lands AFTER a write has already committed, so an
 * unbounded one turns "the edit worked" into "memory is unavailable for the rest of this
 * turn" — and the model, unable to re-open the file, may tell the person the edit did not
 * land. A quarter of a page, because the snippet is nine lines of context and not a read:
 * `memory_open` is what reads a file, and the reply says so when it cuts.
 */
export const EDIT_SNIPPET_MAX_BYTES = 2_000;

/** The turn ceiling: ~11,900 tokens at 4.2 B/tok. */
export const VAULT_TURN_MAX_BYTES = 50_000;

export type VaultBudget = {
  /** The text to hand the model — verbatim while there is room, the exhausted sentence
   *  once there is not. */
  emit(text: string): string;
  spentBytes(): number;
};

/** The sentence the model gets instead of a result, once the turn's vault allowance is
 *  gone. It says what happened and what to do about it: nothing else this turn will
 *  return anything, so "retry" is not among the options. */
const EXHAUSTED =
  "Memory and document results for this turn have reached their budget. Answer from what you already retrieved, or ask the user to narrow the question.";

/** The counter is accumulated by the VAULT TOOLS' OWN result wrapper and NOT by
 *  `withEffectLedger`, whose skip-on-no-`execute` behavior is what the taint fold spent a
 *  whole module routing around. All vault tools have a local `execute` by construction, so
 *  this wrapper is sound for budgeting and unsound for taint. The two are deliberately not
 *  the same mechanism, and this sentence exists so nobody unifies them.
 *
 *  EXHAUSTION IS STICKY. Once a result does not fit, the budget stops answering for the
 *  rest of the turn rather than resuming for whatever happens to be small enough next:
 *  a model that gets one refusal and then a partial answer reads the pair as "keep
 *  trying", which is the loop the ceiling exists to end. It also keeps the transcript
 *  honest — results after the cut would be a biased sample of the small ones. */
export function makeVaultBudget(ceiling: number = VAULT_TURN_MAX_BYTES): VaultBudget {
  let spent = 0;
  let exhausted = false;
  return {
    emit(text) {
      if (exhausted) return EXHAUSTED;
      // BYTES, not characters: a Ukrainian answer is two bytes per character, so a
      // character count would grant a Cyrillic turn twice the context an English one gets.
      const size = Buffer.byteLength(text, "utf8");
      if (spent + size > ceiling) {
        exhausted = true;
        return EXHAUSTED;
      }
      spent += size;
      return text;
    },
    spentBytes: () => spent,
  };
}
