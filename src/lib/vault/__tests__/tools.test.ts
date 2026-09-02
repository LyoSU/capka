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
  it("no longer offers memory_propose or memory_update", async () => {
    // §4.10: the old pair is REMOVED in the same release that ships the new write tools.
    // They do not run beside them — a parallel period was never implementable, because §11.8
    // stops `proposeCandidate` being called from a tool and §2.12 turns `memory_candidates`
    // into a read-only archive from the same moment, and an archive that has stopped being
    // written cannot coexist with two live producers.
    //
    // Asserted as an EQUALITY over the whole set rather than as two absences: a superset
    // check would pass while a tenth tool nobody reviewed rode along, and this file is where
    // the turn's whole surface is stated.
    expect(Object.keys(await make()).sort()).toEqual([
      "memory_fact_write",
      "memory_file",
      "memory_forget",
      "memory_link",
      "memory_note_write",
      "memory_open",
      "memory_search",
    ]);
  });

  it("fails clearly when there is a projectId but no project owner", async () => {
    await expect(make({ projectOwnerUserId: undefined })).rejects.toThrow(/projectOwnerUserId/);
  });
});

/**
 * `memory_propose` and `memory_update` HAD SUITES HERE, and both are gone with the tools
 * (§4.10). Nineteen cases went with them, and none of them is unreplaced: the write path they
 * covered is `memory_fact_write`'s, whose own suite is
 * `fact-write.integration.test.ts` — against a live database, because what it asserts is what
 * gets STORED, which a stubbed `proposeCandidate` never could.
 *
 * What is deliberately NOT kept is the LOST-CAS reply's channel behaviour that lived on
 * `memory_update` (`mismatch`, four cases): the function was that tool's and went with it.
 * `modelTextOf` — the decision those cases were really about — keeps its own coverage in
 * `model-view.integration.test.ts`, on the mint rather than on one caller of it.
 *
 * `memory_forget`'s suite is now `memory-forget.integration.test.ts`: the tool stopped being a
 * refusal with no inputs and became a bounded DELETE, so the interesting assertion is which
 * rows moved, and a mocked module cannot see one.
 */

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
  // The user asked for a CHECK. Every long word of the head is in here, so the predicate
  // that used to gate deletion would say yes.
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

  it("memory_forget has no content test left to spend — it never asks what the turn said", async () => {
    // THE SHAPE OF THE FIX, and it is stronger than the refusal it replaces. The tool can
    // now delete — bounded to rows THIS task wrote (§4.9) — so "it refuses everything" is no
    // longer the property. The property is that the turn's WORDS decide nothing: the bound is
    // a column comparison in the DB write, and `verifyDirectProvenance` is not consulted by
    // this tool at all. A gate that is never called cannot be opened by a page that lines its
    // words up with the user's.
    findCurrentHead.mockResolvedValue(head({ statement: HEAD }));
    const tools = await make({ userTurnText: MENTIONED });
    const out = await run(tools.memory_forget, { handle: "m1", expected_revision: 1 });

    // `m1` was never minted in this run, so it resolves to nothing and no row is touched —
    // which is also the answer to a handle an injected page invented.
    expect(JSON.parse(out).status).toBe("not_found");
    expect(verifyDirectProvenance).not.toHaveBeenCalled();
    expect(findCurrentHead).not.toHaveBeenCalled();
  });

  it("no tool accepts a persistent id — there is nothing for a page to quote back", async () => {
    // The other half, over the WHOLE surface rather than one tool: `memory_update` took a
    // `claim_id` and is gone, and no successor took one over. A handle is minted per run, so
    // an address from a previous turn, from a fetched page, or from the model's own invention
    // resolves to nothing.
    const tools = await make();
    for (const [name, t] of Object.entries(tools)) {
      const js = asSchema(t.inputSchema as never).jsonSchema as { properties?: Record<string, unknown> };
      const fields = Object.keys(js.properties ?? {});
      for (const banned of ["claim_id", "note_id", "space_id", "id"]) {
        expect(fields, `${name}.${banned}`).not.toContain(banned);
      }
    }
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

  it("every mutation's CAS parameter is REQUIRED, not optional", async () => {
    // M17's rule, over the whole surface rather than one tool: an optional CAS parameter is
    // an optional CAS. The two that took a `.refine` for it are gone; what is left states the
    // requirement in the schema the provider actually receives, so a model that omits it is
    // corrected before a database is touched.
    const tools = await make();
    const required = (t: Tools[keyof Tools]) => (asSchema(t.inputSchema as never).jsonSchema as { required?: string[] }).required ?? [];
    expect(required(tools.memory_file)).toContain("expected_item_revision");
    expect(required(tools.memory_link)).toContain("expected_note_revision");
    expect(required(tools.memory_forget)).toEqual(["handle", "expected_revision"]);
  });

  it("the write descriptions say the fact IS saved, and forget says what it can undo", async () => {
    // The model reads these before it reads any result, and until slice 2 they had to say the
    // opposite: a proposal waited for a person. The gate is gone, so a description that still
    // promised a confirmation step would teach the model to tell the user their fact is
    // waiting somewhere it is not.
    const tools = await make();
    for (const t of [tools.memory_fact_write, tools.memory_note_write] as const) {
      expect(t.description).toContain("saved immediately");
      expect(t.description).toContain("undo");
      expect(t.description).not.toMatch(/does not enter memory|waiting for|until they confirm/);
    }
    // And forget's own reversal: it used to say "cannot remove" unconditionally.
    expect(tools.memory_forget.description).toContain("THIS turn");
    expect(tools.memory_forget.description).toContain("memory page");
    expect(tools.memory_forget.description).not.toContain("cannot remove");
  });

  it("memory_note_write takes a section, and refuses a fifth value at the schema", async () => {
    // THE BOUND IS THE PROVIDER'S, like `queries` above: a model that invents a heading is
    // corrected before a database is touched, and the CHECK on `vault_notes.section` is the
    // backstop rather than the diagnosis. Four values and no more — a free string here
    // would give the page a fifth group to render and explain.
    const schema = asSchema((await make()).memory_note_write.inputSchema as never);
    const call = (section?: string) => ({
      op: {
        kind: "create",
        scope: "user",
        title: "Beans",
        content: [{ kind: "markdown", text: "The dog's name." }],
      },
      grounding: { kind: "agent_inference" },
      ...(section === undefined ? {} : { section }),
    });
    const accepts = async (v: unknown) => (await schema.validate!(v)).success;

    for (const s of ["you", "topic", "area", "person"]) expect(await accepts(call(s))).toBe(true);
    expect(await accepts(call("relationship"))).toBe(false);
    expect(await accepts(call(""))).toBe(false);
    // OPTIONAL, and that is load-bearing rather than lenient: an update that says nothing
    // about the heading must leave the file where the person filed it, so `section` cannot
    // be required and cannot carry a schema default either.
    expect(await accepts(call())).toBe(true);
    const js = asSchema((await make()).memory_note_write.inputSchema).jsonSchema as { required?: string[] };
    expect(js.required ?? []).not.toContain("section");
  });

  it("the edit arms take their own fields and refuse the whole-file ones", async () => {
    // WHY THE FIELDS MOVED INTO THE OP. Five arms write a note and they take different
    // things; at the top level every one of those fields would have to be optional, and an
    // optional field is one the model may send on any arm. Inside the discriminated union
    // the provider corrects a mismatched call before a database is touched — which is the
    // same bound `section` and `queries` are held to, one tool over.
    const schema = asSchema((await make()).memory_note_write.inputSchema as never);
    const accepts = async (v: unknown) => (await schema.validate!(v)).success;
    const g = { kind: "agent_inference" };

    expect(await accepts({ op: { kind: "str_replace", note_handle: "n1", expected_revision: 2, old_str: "a", new_str: "b" }, grounding: g })).toBe(true);
    // `new_str` is OPTIONAL — omitting it is a deletion, as in the reference tool.
    expect(await accepts({ op: { kind: "str_replace", note_handle: "n1", expected_revision: 2, old_str: "a" }, grounding: g })).toBe(true);
    // ...but `old_str` is not, and neither is the CAS.
    expect(await accepts({ op: { kind: "str_replace", note_handle: "n1", expected_revision: 2, new_str: "b" }, grounding: g })).toBe(false);
    expect(await accepts({ op: { kind: "str_replace", note_handle: "n1", old_str: "a" }, grounding: g })).toBe(false);
    // A whole-file field on an edit arm is REFUSED, not quietly dropped: a model that sends
    // a body with a str_replace has misunderstood which call it is making, and stripping the
    // field would let it believe the body landed.
    expect(
      await accepts({
        op: { kind: "str_replace", note_handle: "n1", expected_revision: 2, old_str: "a", new_str: "b", content: [{ kind: "markdown", text: "x" }] },
        grounding: g,
      }),
    ).toBe(false);
    // AT THE TOP LEVEL TOO, which the arm's own `.strict()` says nothing about: a body sent
    // beside the op rather than inside it was silently stripped, so a model that put it in
    // the wrong place was told its edit succeeded with a body it thinks it sent.
    expect(
      await accepts({
        op: { kind: "str_replace", note_handle: "n1", expected_revision: 2, old_str: "a", new_str: "b" },
        content: [{ kind: "markdown", text: "x" }],
        grounding: g,
      }),
    ).toBe(false);
    expect(
      await accepts({
        op: { kind: "str_replace", note_handle: "n1", expected_revision: 2, old_str: "a" },
        title: "Beans",
        grounding: g,
      }),
    ).toBe(false);
    // And the arms that DO take them still do, so the outer strictness is a fence and not a
    // wall.
    expect(
      await accepts({
        op: { kind: "create", scope: "user", title: "Beans", content: [{ kind: "markdown", text: "x" }] },
        grounding: g,
      }),
    ).toBe(true);
    // And an invented arm is not an arm.
    expect(await accepts({ op: { kind: "delete", note_handle: "n1", expected_revision: 2 }, grounding: g })).toBe(false);

    expect(await accepts({ op: { kind: "insert", note_handle: "n1", expected_revision: 2, insert_line: 0, insert_text: "x" }, grounding: g })).toBe(true);
    // 0 is the top of the file and is legal; a negative line is not a line.
    expect(await accepts({ op: { kind: "insert", note_handle: "n1", expected_revision: 2, insert_line: -1, insert_text: "x" }, grounding: g })).toBe(false);
    expect(await accepts({ op: { kind: "rename", note_handle: "n1", expected_revision: 2, title: "New title" }, grounding: g })).toBe(true);
    expect(await accepts({ op: { kind: "rename", note_handle: "n1", expected_revision: 2, title: "" }, grounding: g })).toBe(false);
  });

  it("the note description steers a topic FILE per subject, updated rather than duplicated", async () => {
    // The page's top level is a list of files a person opens and reads. A turn that saves
    // everything it learns as one-line claims therefore produces a page of empty headings,
    // and this description plus the manifest's line are the only two things that decide
    // which writer a model reaches for. Pinned, because copy that steers behaviour is not
    // decoration — the release that shipped the write tools while the prompt still named
    // `memory_propose` is the recorded cost of leaving it unpinned.
    const { description } = (await make()).memory_note_write;
    expect(description).toContain("topic file");
    expect(description).toContain("UPDATE it rather than writing a second");
    expect(description).toContain("section");
    // And WHICH writer to reach for once the file exists. The edit arms are worth nothing if
    // the model keeps re-sending whole bodies, and this sentence plus the manifest's are the
    // only two places that decide it — the same reason the sentence above is pinned.
    expect(description).toContain("str_replace");
    expect(description).toContain("insert");
    expect(description).toContain("use update only when most of the file changes");
    // The reference tool's own housekeeping line: files that stay current and few.
    expect(description).toContain("up to date, coherent and organized");
  });
});
