import { describe, it, expect, vi, beforeEach } from "vitest";
import { asSchema } from "ai";

// The services are mocked on purpose: each has its own integration suite against a
// live database, and what is checked here is exactly what exists only in this module
// — WHICH arguments the tools call them with, and what the model sees in reply.
const {
  getOrCreateSpace,
  findCurrentHead,
  listMemoryToolRows,
  countWithheld,
  proposeCandidate,
  verifyDirectProvenance,
} = vi.hoisted(() => ({
  getOrCreateSpace: vi.fn(),
  findCurrentHead: vi.fn(),
  listMemoryToolRows: vi.fn(),
  countWithheld: vi.fn(),
  proposeCandidate: vi.fn(),
  verifyDirectProvenance: vi.fn(),
}));
vi.mock("../spaces", () => ({ getOrCreateSpace }));
// `findCurrentHead` is replaced; the rest of the module is REAL, because `modelTextOf`
// (deliberately not stubbed, below) reaches back into it for the clamping every
// model-facing reader applies. Stubbing the whole module made that a runtime error the
// first time this suite exercised the withheld path.
vi.mock("../claims", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claims")>()),
  findCurrentHead,
}));
// `modelTextOf` is NOT stubbed. It is the decision about whether a statement may be
// shown to the model at all, and a per-file stub of it would let these tests agree with
// a rule the shipped code no longer holds — which is exactly how the search filter came
// to be missing its quarantine half for a whole plan.
vi.mock("../model-view", async (importOriginal) => ({
  listMemoryToolRows,
  countWithheld,
  modelTextOf: (await importOriginal<typeof import("../model-view")>()).modelTextOf,
}));
// `spaceForScope` is NOT stubbed either: it exists to give this module and extraction
// ONE answer to "where does an unqualified fact go", which a per-file stub would undo.
vi.mock("../candidates", async (importOriginal) => ({
  proposeCandidate,
  spaceForScope: (await importOriginal<typeof import("../candidates")>()).spaceForScope,
}));
// `verifyDirectProvenance` moved to the leaf `quote-match.ts` and `tools.ts` imports it
// from there, so the spy is mounted on THAT module. Left on `../candidates` it would
// intercept nothing and the H1 assertions below would be asserting about a spy the code
// never reaches.
vi.mock("../quote-match", () => ({ verifyDirectProvenance }));

import { makeVaultMemoryTools } from "../tools";
import { MEMORY_SEARCH_MAX_RESULTS, makeVaultBudget } from "../budget";
import { HANDLE_RE, makeHandleMap } from "../handles";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";

const USER_SPACE = "space-user";
const PROJECT_SPACE = "space-project";

/** The exact sentence returned for a head that is not there any more. It must not
 *  name a single cause: the chain may have been forgotten, superseded, or simply be
 *  in a space this caller cannot see, and `claims.ts` deliberately does not tell
 *  those apart. */
const GONE = "That claim is no longer there (forgotten or replaced). Run memory_search to see what is.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = (toolCallId: string) => ({ toolCallId, messages: [] }) as any;

/** A head as `findCurrentHead` returns it — carrying `promptAccess`, because that is what
 *  `modelTextOf` reads to decide whether the words may be repeated.
 *
 *  `promptAccess` is DERIVED here rather than defaulted, and it has to be: the column is
 *  GENERATED in Postgres, so a fixture that let a caller set `sensitive: true` while
 *  leaving `promptAccess: "manifest"` would build a row the database cannot produce, and
 *  a fixture that simply omitted it made every one of these assertions pass because
 *  `undefined` matches no channel — an absence that reads exactly like withholding. */
const head = (
  over: Partial<{
    id: string;
    revision: number;
    statement: string;
    slotKey: string | null;
    reviewStatus: string;
    sensitive: boolean;
    promptAccess: string;
  }> = {},
) => {
  const base = {
    id: "c1",
    revision: 1,
    statement: "The client pays in hryvnia",
    slotKey: null,
    value: null,
    reviewStatus: "confirmed",
    sensitive: false,
    ...over,
  };
  return { ...base, promptAccess: over.promptAccess ?? (base.sensitive ? "owner_only" : "manifest") };
};

/** A row as the memory-tool mint hands it back: already filtered to the channel AND
 *  already matched, ranked and sliced by the database, which is why this shape carries no
 *  flags to filter on and no text for this module to search.
 *
 *  `spaceId` and `sourceClass` are on it because slice 2's result shape describes both, and
 *  both come off the authoritative claim row in the mint's join rather than off the search
 *  projection. The default is the PROJECT space, so `scope` has a value that can be wrong:
 *  a fold that always answered "user" would pass a fixture defaulted the other way. */
const visible = (
  over: Partial<{
    id: string;
    revision: number;
    excerpt: string;
    slotKey: string | null;
    spaceId: string;
    sourceClass: string;
  }> = {},
) => ({
  id: "c1",
  spaceId: PROJECT_SPACE,
  revision: 1,
  kind: "claim" as const,
  excerpt: "The client pays in hryvnia",
  slotKey: null,
  value: null,
  sourceClass: "user_direct",
  ...over,
});

/** A NOTE row, the second arm of the union the mint returns from slice 2. `topic` is the
 *  note's OWN label when it is a topic container and `null` otherwise — never a lookup of a
 *  containing topic, which the mint deliberately does not do. */
const visibleNote = (
  over: Partial<{ id: string; revision: number; title: string; excerpt: string; topic: string | null; spaceId: string }> = {},
) => ({
  id: "n1",
  spaceId: USER_SPACE,
  revision: 4,
  kind: "note" as const,
  title: "Quarterly ledger",
  excerpt: "Reports go out on Fridays",
  topic: "Acme",
  sourceClass: "agent_inferred",
  ...over,
});

/** The sentence `memory_search` ships on EVERY reply, empty ones included. */
const NOTE = "No lexical match is not evidence of absence - try other wordings.";

/** What the model actually receives: one JSON object, parsed back. */
const searched = async (
  tools: Awaited<ReturnType<typeof makeVaultMemoryTools>>,
  args: Record<string, unknown>,
): Promise<{
  results: { handle: string; kind: string; title: string | null; excerpt: string; revision: number; sourceClass: string; scope: string; topic: string | null }[];
  omitted: number;
  withheld: number;
  note: string;
}> => JSON.parse(await run(tools.memory_search, args));

const make = (over: Partial<Parameters<typeof makeVaultMemoryTools>[0]> = {}) =>
  makeVaultMemoryTools({
    userId: "u1",
    projectId: "p1",
    projectOwnerUserId: "u1",
    messageId: "m1",
    taskId: "t1",
    userTurnText: "The client pays in hryvnia, remember that",
    handles: makeHandleMap(),
    budget: makeVaultBudget(),
    // `write` is a no-op: a unit test asserts the tools' behavior, not the flip-write, and
    // T6 already pins the write itself. `seeded: false` is the ordinary turn.
    taint: makeTurnTaint({ messageId: "m1", seeded: false, write: async () => {} }),
    ...over,
  });

type Tools = Awaited<ReturnType<typeof makeVaultMemoryTools>>;
const run = async (tool: Tools[keyof Tools], args: unknown, toolCallId = "call-1"): Promise<string> =>
  (await tool.execute!(args as never, opts(toolCallId))) as string;

beforeEach(() => {
  vi.resetAllMocks();
  getOrCreateSpace.mockImplementation(async (scope: { type: string }) =>
    scope.type === "project" ? PROJECT_SPACE : USER_SPACE,
  );
  verifyDirectProvenance.mockReturnValue(true);
  listMemoryToolRows.mockResolvedValue({ rows: [], omitted: 0 });
  countWithheld.mockResolvedValue(0);
  proposeCandidate.mockResolvedValue({ state: "pending", candidateId: "cand1" });
});

describe("makeVaultMemoryTools — the factory", () => {
  it("hands back exactly four tools", async () => {
    expect(Object.keys(await make()).sort()).toEqual([
      "memory_forget",
      "memory_propose",
      "memory_search",
      "memory_update",
    ]);
  });

  it("fails clearly when there is a projectId but no project owner", async () => {
    await expect(make({ projectOwnerUserId: undefined })).rejects.toThrow(/projectOwnerUserId/);
  });
});

describe("memory_propose", () => {
  it("takes the project space, records provenance, and keys by task:message:toolCall", async () => {
    const tools = await make();
    const out = await run(tools.memory_propose, { statement: "The client pays in hryvnia" }, "call-7");
    // The reply says where the fact IS, which is the whole point of a proposal-only
    // memory: a silent pend is a black hole.
    expect(out).toContain("waiting");
    expect(out).toContain("memory page");

    expect(verifyDirectProvenance).toHaveBeenCalledWith(
      "The client pays in hryvnia",
      "The client pays in hryvnia, remember that",
    );
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "t1:m1:call-7",
        spaceId: PROJECT_SPACE,
        originMessageId: "m1",
        statement: "The client pays in hryvnia",
        // RECORDED, not obeyed: the ledger pends this either way. See the H1 block.
        provenance: { kind: "user_direct", messageId: "m1" },
        evidence: [{ messageId: "m1" }],
      }),
    );
  });

  it("outside a project the default is the user space, and a turn mismatch yields derived", async () => {
    verifyDirectProvenance.mockReturnValue(false);
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });

    const out = await run(tools.memory_propose, { statement: "Favourite colour is blue" });
    expect(out).toContain("waiting");
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: USER_SPACE, provenance: { kind: "derived", messageId: "m1" } }),
    );
  });

  it("an explicit scope overrides the default", async () => {
    const tools = await make();
    await run(tools.memory_propose, { statement: "Lives in Lviv", scope: "user" });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("outside a project an explicit scope:'project' saves NOTHING and says so", async () => {
    // Falling back to the user space gives the fact a WIDER audience than was asked
    // for. Same rule as memory_search: the model asked for a space that does not exist
    // here, so say so instead of substituting one.
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });
    const out = await run(tools.memory_propose, { statement: "Deadline on Friday", scope: "project" });
    expect(out).toContain("not inside a project");
    expect(out).toContain("Nothing was saved");
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("broken value_json is a tool RESULT, not a throw, and no proposal happened", async () => {
    const tools = await make();
    const out = await run(tools.memory_propose, { statement: "Payment terms 30 days", value_json: "{nope" });
    expect(out).toMatch(/^value_json is not valid JSON: /);
    expect(out).toContain("Re-send with corrected JSON or omit it.");
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("valid value_json travels parsed, together with the slot and the sensitivity", async () => {
    const tools = await make();
    await run(tools.memory_propose, {
      statement: "Payment terms 30 days",
      slot_key: "supplier/acme/payment-terms",
      value_json: '{"days":30}',
      sensitive: true,
    });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ value: { days: 30 }, slotKey: "supplier/acme/payment-terms", sensitive: true }),
    );
  });

  it("relays the policy's decision in words, not as a state", async () => {
    const tools = await make();
    proposeCandidate.mockResolvedValue({ state: "known", claimId: "c2" });
    // "Already saved", not "added this conversation as evidence" — because nothing was
    // written. The old wording described a durable write this path no longer makes.
    expect(await run(tools.memory_propose, { statement: "The client pays in hryvnia" })).toBe(
      "Already saved — nothing to do.",
    );
    proposeCandidate.mockResolvedValue({ state: "retired" });
    expect(await run(tools.memory_propose, { statement: "x" })).toContain("memory was deleted");
  });

  it("keys a proposal by task, so two tasks on one message row cannot collide", async () => {
    const keys: string[] = [];
    proposeCandidate.mockImplementation(async (input: { idempotencyKey: string }) => {
      keys.push(input.idempotencyKey);
      return { state: "pending", candidateId: "cand1" };
    });

    // The two halves of one approval turn: same message row, same tool-call id (a provider
    // that numbers them per request), different task.
    for (const taskId of ["task-first", "task-continuation"]) {
      const tools = await makeVaultMemoryTools({
        userId: "u1", messageId: "m1", taskId,
        userTurnText: "we pay our suppliers in euros",
        handles: makeHandleMap(),
        budget: makeVaultBudget(),
        taint: makeTurnTaint({ messageId: "m1", seeded: false, write: async () => {} }),
      });
      await tools.memory_propose.execute!({ statement: "We pay our suppliers in euros" }, { toolCallId: "call_0" } as never);
    }

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain("task-first");
  });
});

describe("memory_update — records a correction, writes nothing", () => {
  it("proposes a conflict against the head it contests, and names it", async () => {
    findCurrentHead.mockResolvedValue(head({ id: "c1", revision: 3 }));
    const tools = await make({ userTurnText: "Actually the client pays in dollars now" });

    const out = await run(tools.memory_update, {
      claim_id: "c1",
      expected_revision: 3,
      statement: "The client pays in dollars",
    });

    expect(out).toContain("memory page");
    expect(out).toContain("unchanged");
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: "The client pays in dollars",
        // Naming the head is what lets the page render "keeping this replaces «…»".
        // A bare conflict is a question nobody can answer.
        forceConflict: { conflictsWith: "c1" },
        evidence: [{ messageId: "m1" }],
      }),
    );
  });

  it("carries the contested head's sensitivity onto the proposal", async () => {
    // Sensitivity is a property of the FACT. Dropping it here would put the correction
    // of a closed fact unmarked in front of the person.
    findCurrentHead.mockResolvedValue(head({ sensitive: true }));
    const tools = await make();
    await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "Different wording now" });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
  });

  it("a stale revision is answered with what is there now, and records nothing", async () => {
    findCurrentHead.mockResolvedValue(head({ revision: 4 }));
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "New wording" });
    expect(out).toContain("revision 4");
    expect(out).toContain("The client pays in hryvnia");
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("a mismatch on a SENSITIVE head names the revision without repeating the text", async () => {
    findCurrentHead.mockResolvedValue(head({ revision: 4, statement: "diagnosed in March", sensitive: true }));
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "New wording" });
    expect(out).toContain("revision 4");
    expect(out).not.toContain("March");
  });

  it("a mismatch on an OFF-CHANNEL head withholds the text too", async () => {
    // `findCurrentHead` has no channel filter — it answers "does this chain exist" — so
    // the rule has to hold on the sentence. It does, via `modelTextOf`, which is the same
    // decision the manifest and search make.
    //
    // The premise moved with the cutover and the test moved with it rather than keeping
    // its old name over a new rule: this used to be a QUARANTINED head (`unverified`),
    // and an unverified head is `agent_inferred` -> `memory_search`, which a memory TOOL
    // reply may legitimately repeat. What may not appear in a tool reply is a channel
    // below it — `knowledge_search`, the class an untrusted document produces.
    findCurrentHead.mockResolvedValue(
      head({ revision: 2, statement: "read off a web page", promptAccess: "knowledge_search" }),
    );
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "New wording" });
    expect(out).toContain("revision 2");
    expect(out).not.toContain("read off a web page");
  });

  it("a mismatch on a memory_search-class head DOES repeat the text", async () => {
    // OWNED, NOT INCIDENTAL. The channel cutover widened this reply: it used to withhold a
    // head a person had not confirmed, and `review_status` now reaches no model channel, so
    // a `memory_search`-class head has its words echoed here. That is the correct rule and
    // this assertion is what makes it a decision rather than a drift — the lost-CAS sentence
    // IS the memory-tool channel, the same one `memory_search` would have handed those words
    // back on a moment earlier, so withholding them here would withhold nothing.
    //
    // It is also the control beside the off-channel test above: asserting only the absence
    // would pass just as well if `modelTextOf` returned `null` for everything — which is
    // exactly the state this suite was in for one run, because the fixture had no
    // `promptAccess` at all.
    findCurrentHead.mockResolvedValue(
      head({ revision: 2, statement: "proposed by the agent", promptAccess: "memory_search" }),
    );
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "New wording" });
    expect(out).toContain("proposed by the agent");
  });

  it("someone else's claim reads as nonexistent and records nothing", async () => {
    findCurrentHead.mockResolvedValue(null);
    const tools = await make();
    expect(await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "x" })).toBe(GONE);
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("a head whose space does not resolve records nothing rather than guessing a scope", async () => {
    // Found by the scoped lookup, gone by the time the space probe runs. Filing it in
    // the user space would turn one project's business into a fact about the person.
    findCurrentHead.mockResolvedValueOnce(head()).mockResolvedValue(null);
    const tools = await make();
    expect(await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "x" })).toBe(GONE);
    expect(proposeCandidate).not.toHaveBeenCalled();
  });
});

describe("memory_forget — refuses, and says who can", () => {
  it("removes nothing, whatever the user said", async () => {
    const tools = await make({ userTurnText: "Forget that the client pays in hryvnia, it is out of date" });
    const out = await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1 });
    expect(out).toContain("Nothing was forgotten");
    expect(out).toContain("only the user");
    expect(out).toContain("memory page");
  });

  it("does not even look the claim up — there is no branch that could delete it", async () => {
    // The strongest form the assertion can take here: a refusal that reads the head is
    // one re-write away from a refusal that has an exception. This one has no inputs.
    const tools = await make({ userTurnText: "Forget that the client pays in hryvnia" });
    await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1 });
    expect(findCurrentHead).not.toHaveBeenCalled();
    expect(proposeCandidate).not.toHaveBeenCalled();
  });
});

describe("memory_search", () => {
  it("returns handles, never persistent ids", async () => {
    // THE POINT OF THE SLICE-2 SHAPE. A persistent id in a tool result is an id an injected
    // page can quote back at a write tool; a handle is void the moment the run ends. The
    // assertion is over the WHOLE serialized row rather than over `handle` alone, because
    // the leak this guards against is a second field carrying the id beside the handle —
    // which is exactly what `[id@revision]` was.
    listMemoryToolRows.mockResolvedValue({
      rows: [
        visible({ id: "claim-real-id-1", revision: 2, excerpt: "The client pays in Hryvnia" }),
        visibleNote({ id: "note-real-id-2" }),
      ],
      omitted: 0,
    });
    const out = await searched(await make(), { queries: ["acme"] });
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r.handle).toMatch(HANDLE_RE);
      expect(JSON.stringify(r)).not.toContain("claim-real-id-1");
      expect(JSON.stringify(r)).not.toContain("note-real-id-2");
    }
    // The LETTER is the whole of what a handle says about its target: `m` a fact, `n` a note.
    expect(out.results.map((r) => r.handle)).toEqual(["m1", "n1"]);
  });

  it("describes each row by kind, trust tier and which memory it came from", async () => {
    // MATCHING IS NO LONGER THIS MODULE'S JOB. The two-lane fusion and the channel join
    // happen in the mint, against a database, and are proved in
    // `vault-search.integration.test.ts`; what is checked here is the one thing that exists
    // only in this file — how a returned row is described to the model.
    //
    // `scope` is FOLDED from the space id and the id itself never appears: the model is told
    // which memory a row came from, not the row's storage key.
    listMemoryToolRows.mockResolvedValue({
      rows: [visible({ spaceId: PROJECT_SPACE }), visibleNote({ spaceId: USER_SPACE })],
      omitted: 0,
    });
    const out = await searched(await make(), { queries: ["hryvni"] });
    expect(out.results[0]).toEqual({
      handle: "m1",
      kind: "claim",
      // A claim has no title, and no containing-topic lookup exists in the mint's claim arm.
      title: null,
      topic: null,
      excerpt: "The client pays in hryvnia",
      revision: 1,
      sourceClass: "user_direct",
      scope: "project",
    });
    expect(out.results[1]).toEqual({
      handle: "n1",
      kind: "note",
      title: "Quarterly ledger",
      topic: "Acme",
      excerpt: "Reports go out on Fridays",
      revision: 4,
      sourceClass: "agent_inferred",
      scope: "user",
    });
    expect(JSON.stringify(out)).not.toContain(PROJECT_SPACE);
    expect(JSON.stringify(out)).not.toContain(USER_SPACE);
  });

  it("asks the mint ONCE, across both spaces, with every wording and the ceiling", async () => {
    // The assertion that this reader carries no copy of the admission rule and no search
    // of its own. One call, not one per space and not one per WORDING: a fused score is
    // comparable across spaces and across query variants, so the ceiling is spent on
    // relevance instead of on an arithmetic split — which is what the deleted `quota` was.
    const tools = await make();
    await run(tools.memory_search, { queries: ["rakhunok", "invoice"] });
    expect(listMemoryToolRows.mock.calls).toEqual([
      [
        [PROJECT_SPACE, USER_SPACE],
        { queries: ["rakhunok", "invoice"], limit: MEMORY_SEARCH_MAX_RESULTS, kinds: undefined },
      ],
    ]);
  });

  it("passes kinds and a narrowed limit through to the mint", async () => {
    const tools = await make();
    await run(tools.memory_search, { queries: ["x"], kinds: ["note"], limit: 3 });
    expect(listMemoryToolRows.mock.calls[0][1]).toEqual({ queries: ["x"], limit: 3, kinds: ["note"] });
  });

  it("an empty result is still a well-formed object with the note on it", async () => {
    const out = await searched(await make(), { queries: ["nothing"] });
    expect(out).toEqual({ results: [], omitted: 0, withheld: 0, note: NOTE });
  });

  it("scope narrows the spaces; the default takes both", async () => {
    // A CONTROL WAS RETIRED HERE BY DESIGN, not lost in the edit: "an overflowing project
    // does not crowd the user space off the list" asserted the per-space quota that split
    // the ceiling 10/10. Task 11 deleted the quota deliberately — a fused score IS
    // comparable across spaces, so the ceiling is spent on relevance, and a guaranteed
    // per-space share is exactly what that buys back at the cost of showing worse matches.
    // The property has a successor rather than no replacement: `scope` is the caller's
    // escape hatch, and this test is the one that pins it. Recorded so the deletion reads
    // as a decision instead of netting out as "+1 test".
    const tools = await make();
    await run(tools.memory_search, { queries: ["x"], scope: "user" });
    expect(listMemoryToolRows.mock.calls.map((c) => c[0])).toEqual([[USER_SPACE]]);
  });

  it("reports what it omitted rather than truncating silently", async () => {
    // A silent truncation reads to the model as "that is all there is", which is the same
    // wrong conclusion the absence note exists to prevent, arrived at from the other
    // direction. The count comes from the mint, which is the only place the slice happens —
    // this module must neither invent it nor drop it.
    listMemoryToolRows.mockResolvedValue({
      rows: Array.from({ length: MEMORY_SEARCH_MAX_RESULTS }, (_, i) =>
        visible({ id: `c${i}`, excerpt: `fact ${i}` }),
      ),
      omitted: 10,
    });
    const out = await searched(await make(), { queries: ["fact"] });
    expect(out.results).toHaveLength(MEMORY_SEARCH_MAX_RESULTS);
    expect(out.omitted).toBe(10);
    // And zero is EMITTED, not omitted: a missing field reads as "unknown", which is the
    // one thing it is not.
    listMemoryToolRows.mockResolvedValue({ rows: [visible()], omitted: 0 });
    expect(await searched(await make(), { queries: ["fact"] })).toMatchObject({ omitted: 0 });
  });

  it("ships the absence note on EVERY response, not only empty ones", async () => {
    // An agent that reads it only on zero results has already concluded absence on a thin
    // result set, which is the wrong conclusion this sentence exists to prevent.
    listMemoryToolRows.mockImplementation(async (_ids: string[], o: { queries: string[] }) =>
      o.queries[0] === "acme" ? { rows: [visible()], omitted: 0 } : { rows: [], omitted: 0 },
    );
    const tools = await make();
    expect((await searched(tools, { queries: ["acme"] })).note).toMatch(/not evidence of absence/);
    expect((await searched(tools, { queries: ["zzzz"] })).note).toMatch(/not evidence of absence/);
  });

  it("the withheld count is an aggregate, and is the same whatever was asked", async () => {
    // Withholding the text while still MATCHING on it is not withholding: a hit for
    // "diagnosis" confirms the category the withholding exists to protect. The count
    // comes from its own aggregate over rows the projection never returns, so it cannot
    // vary with the query even by accident — and it is a bare NUMBER, with no handle
    // beside it, because there is no operation the agent could perform on one of those rows.
    listMemoryToolRows.mockImplementation(async (_ids: string[], o: { queries: string[] }) =>
      o.queries[0] === "hryvnia"
        ? { rows: [visible({ id: "c2", excerpt: "The client pays in hryvnia" })], omitted: 0 }
        : { rows: [], omitted: 0 },
    );
    countWithheld.mockImplementation(async (spaceId: string) => (spaceId === PROJECT_SPACE ? 1 : 0));
    const tools = await make();

    const probe = await searched(tools, { queries: ["diagnosed"] });
    expect(probe.results).toEqual([]);
    const other = await searched(tools, { queries: ["hryvnia"] });
    expect(other.results).toHaveLength(1);

    expect(probe.withheld).toBe(1);
    expect(other.withheld).toBe(1);
  });

  it("outside a project scope:'project' substitutes no space and returns empty", async () => {
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });
    expect(await searched(tools, { queries: ["x"], scope: "project" })).toEqual({
      results: [],
      omitted: 0,
      withheld: 0,
      note: NOTE,
    });
    // The mint IS asked, and it is asked about NOTHING — which is the honest shape: the
    // model requested a scope that does not exist here, and no space is substituted for
    // it. `countWithheld` is not called at all, so the count of sensitive records cannot
    // leak out of a space that was not in scope.
    expect(listMemoryToolRows.mock.calls.map((c) => c[0])).toEqual([[]]);
    expect(countWithheld).not.toHaveBeenCalled();
  });

  it("spends the turn's vault budget, and says so when it is gone", async () => {
    // THE CEILING BECOMES LIVE IN THIS COMMIT. `ctx.budget` has been threaded since T7 and
    // read by nothing, so the 50,000-byte per-turn allowance was inert: this is the first
    // result that goes through `emit`, and without that call a turn could spend the whole
    // context on twenty searches. A tiny ceiling is the cheapest way to observe the wiring.
    const budget = makeVaultBudget(40);
    listMemoryToolRows.mockResolvedValue({ rows: [visible()], omitted: 0 });
    const tools = await make({ budget });
    const out = await run(tools.memory_search, { queries: ["hryvnia"] });
    expect(out).toContain("reached their budget");
    expect(() => JSON.parse(out)).toThrow();
    // And it is CHARGED, not merely consulted: a `spentBytes` of 0 would mean the wrapper
    // returned the text without accounting for it.
    const roomy = makeVaultBudget();
    await run((await make({ budget: roomy })).memory_search, { queries: ["hryvnia"] });
    expect(roomy.spentBytes()).toBeGreaterThan(0);
  });

  it("mints ONE handle for a row seen twice in the same run", async () => {
    // The map is per RUN and per target, so a row that comes back in two searches of one
    // turn is addressed by one name. Two names for one row is a distinction the model would
    // have to invent a meaning for.
    listMemoryToolRows.mockResolvedValue({ rows: [visible()], omitted: 0 });
    const tools = await make();
    const first = await searched(tools, { queries: ["a"] });
    const second = await searched(tools, { queries: ["b"] });
    expect(second.results[0].handle).toBe(first.results[0].handle);
  });
});

/**
 * H1 — THE AUDIT'S OWN SCENARIO, and the four siblings it warns not to stop short of.
 *
 * The setup is the one that made the old gate indefensible. The user asks the assistant
 * to CHECK a fact on a website. Their turn therefore contains every long word of the
 * recorded claim — legitimately, because they named the thing they asked about. The
 * page the assistant fetches then tells it to act on that claim. Textual overlap says
 * yes to the attack and to the honest case identically, so these tests drive the REAL
 * `verifyDirectProvenance` against that turn: the predicate returns true, and nothing
 * happens anyway. A stub returning false would prove nothing at all.
 *
 * Five attempts, because stopping at the vivid one is how four of them survive: propose,
 * update, forget, evidence attachment, and the unverified→confirmed escalation that used
 * to ride in on a merge.
 */
describe("H1 — a page cannot write, rewrite or erase memory on the user's mere mention", () => {
  // The user asked for a CHECK. Every long word of the head is in here.
  const MENTIONED = "Check whether Acme invoices are still paid monthly on the vendor website";
  const HEAD = "Acme invoices are paid monthly";

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("../quote-match")>("../quote-match");
    verifyDirectProvenance.mockImplementation(real.verifyDirectProvenance);
  });

  it("the overlap really does pass — the gate would have opened", async () => {
    // The control. Without it every assertion below could be passing because the
    // predicate happens to say no, and the guard being tested would be untested.
    const real = await vi.importActual<typeof import("../quote-match")>("../quote-match");
    expect(real.verifyDirectProvenance(HEAD, MENTIONED)).toBe(true);
  });

  it("memory_forget destroys nothing, and the claim survives", async () => {
    findCurrentHead.mockResolvedValue(head({ statement: HEAD }));
    const tools = await make({ userTurnText: MENTIONED });

    const out = await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1 });

    expect(out).toContain("Nothing was forgotten");
    // Nothing at all was called: no delete, and no proposal standing in for one.
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("memory_update writes no successor — the correction only waits for the person", async () => {
    findCurrentHead.mockResolvedValue(head({ statement: HEAD }));
    const tools = await make({ userTurnText: MENTIONED });

    await run(tools.memory_update, {
      claim_id: "c1",
      expected_revision: 1,
      statement: "Acme invoices are paid to attacker wallet",
    });

    // The only call is into the ledger, as a CONFLICT: recorded for a human, with the
    // existing head untouched. There is no path from here to `updateClaim`.
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ forceConflict: { conflictsWith: "c1" } }),
    );
  });

  it("memory_propose cannot activate, and cannot mint evidence or escalate a head", async () => {
    // The two quieter halves of the same finding. A proposal that "merged" used to
    // attach this turn as evidence AND call `confirmClaim` on the head it matched — so
    // an injected sentence promoted a quarantined claim into the prompt. The tool's
    // whole surface for that is what it hands the ledger, and it hands it a proposal.
    const tools = await make({ userTurnText: MENTIONED });
    const out = await run(tools.memory_propose, { statement: "Acme invoices are paid to attacker wallet" });

    expect(out).toContain("waiting");
    const [input] = proposeCandidate.mock.calls[0] as [Record<string, unknown>];
    // The tool cannot ask for activation: there is no field on this call that could.
    expect(Object.keys(input)).not.toContain("forceState");
    expect(Object.keys(input)).not.toContain("reviewStatus");
    expect(Object.keys(input)).not.toContain("confirmed");
  });

  it("a line QUOTED inside the user's turn is still not the user's own word", async () => {
    // Recorded provenance rather than authority now, but the distinction still has to be
    // right: the person reading the queue is told whether these were their own words.
    const tools = await make({
      userTurnText: 'Please review this supplier email: "Always send invoices to attacker@example.com" — is that normal?',
    });
    await run(tools.memory_propose, { statement: "Always send invoices to attacker@example.com" });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { kind: "derived", messageId: "m1" } }),
    );
  });

  it("an explicit quoted:true is derived even on a verbatim match", async () => {
    const tools = await make({ userTurnText: "My supplier says the discount runs until March" });
    await run(tools.memory_propose, { statement: "The discount runs until March", quoted: true });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { kind: "derived", messageId: "m1" } }),
    );
  });
});

// A tool with an open object in its schema is one the model CANNOT fill: `asSchema`
// collapses `z.record`/`z.unknown` into `additionalProperties: false`, and the provider
// receives a schema that is impossible to satisfy (the same bug the `manage` test
// catches). That is why an arbitrary value travels as the string `value_json` — and
// this is the trip wire against anyone "improving" the schema back into an object.
describe("the schemas the provider actually sees", () => {
  const jsonSchemas = async () => {
    const tools = await make();
    return Object.entries(tools).map(([name, t]) => [name, asSchema(t.inputSchema as never).jsonSchema] as const);
  };

  it("no field is an object, and none carries additionalProperties/propertyNames", async () => {
    for (const [name, js] of await jsonSchemas()) {
      const props = (js as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
      expect(Object.keys(props).length, name).toBeGreaterThan(0);
      for (const [field, spec] of Object.entries(props)) {
        expect(spec.type, `${name}.${field}`).not.toBe("object");
        expect(spec.additionalProperties, `${name}.${field}`).toBeUndefined();
        expect(spec.propertyNames, `${name}.${field}`).toBeUndefined();
      }
    }
  });

  it("rejects 0 and 6 queries at the schema", async () => {
    // THE BOUND IS ON THE SCHEMA, not in `execute`, which is what makes it the provider's
    // problem rather than ours: a model that sends six wordings is corrected before a
    // database is touched. Zero is the other end and is the one that would otherwise pass
    // silently — `listMemoryToolRows` reads an empty `queries` as "no queries at all" and
    // returns every eligible row in the space.
    //
    // Validated through `asSchema(...).validate`, which is the path the AI SDK itself takes
    // on a tool call, rather than through the raw `safeParse` — "at the schema" means the
    // provider-facing contract, and a bound that only a direct Zod call could see is not it.
    const schema = asSchema((await make()).memory_search.inputSchema as never);
    const accepts = async (v: unknown) => (await schema.validate!(v)).success;

    expect(await accepts({ queries: [] })).toBe(false);
    expect(await accepts({ queries: ["a", "b", "c", "d", "e", "f"] })).toBe(false);
    expect(await accepts({ queries: ["a"] })).toBe(true);
    expect(await accepts({ queries: ["a", "b", "c", "d", "e"] })).toBe(true);
    // An empty wording is not a wording either.
    expect(await accepts({ queries: [""] })).toBe(false);
    // And the per-call ceiling is the schema's too, so `limit` cannot buy more than the
    // budget's constant allows.
    expect(await accepts({ queries: ["a"], limit: MEMORY_SEARCH_MAX_RESULTS + 1 })).toBe(false);
    expect(await accepts({ queries: ["a"], limit: 0 })).toBe(false);
  });

  it("memory_search offers the model no persistent-id field to send back", async () => {
    // The other half of "handles, never ids": a result that shows only handles is undone by
    // an input that still accepts a raw id, because the model would learn to keep one.
    const js = asSchema((await make()).memory_search.inputSchema).jsonSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(js.properties ?? {}).sort()).toEqual(["kinds", "limit", "queries", "scope"]);
  });

  it("memory_update requires the statement outright, so there is no refine to lose", async () => {
    // It used to accept statement OR value_json and enforce the "at least one" rule in a
    // `.refine`, which does not reach the JSON Schema — so the requirement had to be
    // repeated in the description. A value-only change carries no words, and a proposal
    // with no words is a row nobody can decide on, so the field is simply required now
    // and the provider's own schema says so.
    const tools = await make();
    const js = asSchema(tools.memory_update.inputSchema).jsonSchema as { required?: string[] };
    expect(js.required).toEqual(["claim_id", "expected_revision", "statement"]);
  });

  it("the descriptions say the fact does not enter memory until the user confirms", async () => {
    // The model reads these before it reads any result. A description promising a save
    // teaches it to tell the user their fact was saved, which is the one thing that must
    // not happen quietly.
    const tools = await make();
    expect(tools.memory_propose.description).toContain("confirm");
    expect(tools.memory_update.description).toContain("approve");
    expect(tools.memory_forget.description).toContain("cannot remove");
  });
});
