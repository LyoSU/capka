import { log } from "@/lib/log";
import { proposeCandidate, verifyDirectProvenance, type Provenance } from "./candidates";

/** What the caller's aux-model wrapper looks like from here. Task 10 builds this on
 *  the same auxGenerate path the old memory-doc reconcile used (`src/lib/memory/doc.ts`),
 *  binding model/provider/label once at the call site — this module knows nothing
 *  about providers, usage accounting, or the AI SDK, only this one shape. */
export type GenerateFn = (opts: {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{ text: string; finishReason: string }>;

const MAX_OUTPUT_TOKENS = 1024;

const EXTRACT_INSTRUCTION =
  `Read the latest turn below and extract any durable facts worth remembering, as a JSON array of objects: ` +
  `{"statement":"…","slot_key"?:"…","sensitive"?:true,"from":"user"|"assistant","quoted"?:true}.\n\n` +
  `"from" says who the fact is asserted by: "user" for something the user stated as true of themselves or their ` +
  `own situation; "assistant" for a fact the assistant asserted — a conclusion, a decision, something it told the ` +
  `user. Set "quoted": true when the user is relaying someone ELSE's words rather than stating their own fact — ` +
  `e.g. "my supplier says the discount ends in March" is quoted; "the discount ends in March" said plainly is not. ` +
  `"slot_key" is an optional short stable path like "payment/currency" for a fact that changes over time and ` +
  `should replace its previous value rather than duplicate it — omit it for one-off facts. Set "sensitive": true ` +
  `for health, politics, religion, or private-life facts.\n\n` +
  `Only durable, reusable facts — never task mechanics, pleasantries, or transient chatter. One fact per item. ` +
  `Output ONLY the JSON array, nothing else. If nothing is worth saving, output [].`;

type ExtractedItem = {
  statement: string;
  slotKey?: string;
  sensitive?: boolean;
  from: string;
  quoted?: boolean;
};

/**
 * Tolerant by design, the same convention as `parseMemoryOps` in the old
 * `src/lib/memory/doc.ts`: auxiliary models wrap JSON in prose or a code fence, so
 * this takes the first `[` … last `]` and parses that slice. Anything that throws
 * or isn't an array yields `[]` — a safe no-op, not an error to log loudly.
 *
 * Returns the RAW parsed entries, not yet validated: the ordinal used for
 * `idempotencyKey` is each entry's position in this array, so validation happens
 * per-entry afterward (see `toExtractedItem`) rather than by filtering here — a
 * dropped malformed entry must not shift the ordinal of the ones after it.
 */
function parseJsonArray(raw: string): unknown[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** One malformed entry (no usable `statement`) must not abort the others — this
 *  returns `null` for it, and the caller simply skips that ordinal. */
function toExtractedItem(entry: unknown): ExtractedItem | null {
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Record<string, unknown>;
  if (typeof o.statement !== "string" || !o.statement.trim()) return null;
  return {
    statement: o.statement.trim(),
    slotKey: typeof o.slot_key === "string" ? o.slot_key : undefined,
    sensitive: o.sensitive === true,
    // Anything other than exactly "user" is treated as not-user below, which
    // routes to `derived` — the fail-safe default for a field the model got wrong
    // or omitted, same spirit as `verifyDirectProvenance` erring toward pending.
    from: typeof o.from === "string" ? o.from : "assistant",
    quoted: o.quoted === true,
  };
}

/**
 * Mine the turn that just finished for candidate facts and file each one through
 * the candidate ledger (`proposeCandidate`). Runs AFTER the reply is already
 * delivered, so nothing here may throw into the caller — a rejection would fail a
 * turn that has already succeeded from the user's point of view.
 *
 * The input is deliberately narrow: only `userText` and `assistantText`, never tool
 * outputs. That is the injection boundary — a fetched web page or an MCP tool
 * result must not be able to write facts into memory by phrasing itself as a
 * statement about the user. `proposeCandidate`'s own gate is the second layer:
 * anything not `user_direct` lands `pending`, never auto-activated.
 */
export async function extractCandidates(args: {
  userSpaceId: string;
  projectSpaceId?: string;
  messageId: string;
  userText: string;
  assistantText: string;
  generate: GenerateFn;
}): Promise<void> {
  let result: { text: string; finishReason: string };
  try {
    result = await args.generate({
      system: EXTRACT_INSTRUCTION,
      prompt: `User: ${args.userText}\n\nAssistant: ${args.assistantText}`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (e) {
    log.error("vault candidate extraction: generate failed", { err: String(e) });
    return;
  }

  // A truncated JSON array can still be syntactically PARSEABLE while missing its
  // tail — a partial extraction would silently drop facts and, worse, could cut a
  // statement mid-sentence and store the fragment as a fact. Bail before parsing,
  // not after: writing nothing is safer than writing something that isn't what was
  // actually said.
  if (result.finishReason === "length") return;

  const rawItems = parseJsonArray(result.text);
  // No per-item scope signal in the schema (unlike memory_propose's tool, which
  // takes an explicit `scope` from the model) — so every item in one turn files to
  // the same space, defaulting to the project when the turn happened inside one,
  // same as memory_propose's own default.
  const spaceId = args.projectSpaceId ?? args.userSpaceId;

  for (let ordinal = 0; ordinal < rawItems.length; ordinal++) {
    const item = toExtractedItem(rawItems[ordinal]);
    if (!item) continue;
    const provenance: Provenance =
      item.from === "user" && !item.quoted && verifyDirectProvenance(item.statement, args.userText)
        ? { kind: "user_direct", messageId: args.messageId }
        : { kind: "derived", messageId: args.messageId };

    try {
      await proposeCandidate({
        // The array's own order is the only handle available here, and it is
        // stable across a re-run of the same finished extraction — which is what
        // makes a retry after a crash a no-op (via the ledger's unique index)
        // instead of a duplicate fact.
        idempotencyKey: `${args.messageId}:extract:${ordinal}`,
        spaceId,
        originMessageId: args.messageId,
        statement: item.statement,
        slotKey: item.slotKey,
        provenance,
        sensitive: item.sensitive,
        evidence: [{ messageId: args.messageId }],
      });
    } catch (e) {
      // One bad candidate must not lose the rest, and this runs after the user's
      // turn already succeeded — log and move on to the next item.
      log.error("vault candidate extraction: propose failed", { err: String(e), ordinal });
    }
  }
}
