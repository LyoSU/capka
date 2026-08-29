import { describe, it, expect, vi, beforeEach } from "vitest";
import { asSchema } from "ai";

// The services are mocked on purpose: each has its own integration suite against a
// live database, and what is checked here is exactly what exists only in this module
// — WHICH arguments the tools call them with, and what the model sees in reply.
const { getOrCreateSpace, listHeadClaims, updateClaim, forgetClaim, findCurrentHead, proposeCandidate, verifyDirectProvenance } =
  vi.hoisted(() => ({
    getOrCreateSpace: vi.fn(),
    listHeadClaims: vi.fn(),
    updateClaim: vi.fn(),
    forgetClaim: vi.fn(),
    findCurrentHead: vi.fn(),
    proposeCandidate: vi.fn(),
    verifyDirectProvenance: vi.fn(),
  }));
vi.mock("../spaces", () => ({ getOrCreateSpace }));
vi.mock("../claims", () => ({ listHeadClaims, updateClaim, forgetClaim, findCurrentHead }));
vi.mock("../candidates", () => ({ proposeCandidate, verifyDirectProvenance }));

import { makeVaultMemoryTools } from "../tools";

const USER_SPACE = "space-user";
const PROJECT_SPACE = "space-project";

/** The exact sentence returned for a head that is not there any more. It must not
 *  name a single cause: the chain may have been forgotten, superseded, or simply be
 *  in a space this caller cannot see, and `claims.ts` deliberately does not tell
 *  those apart. */
const GONE = "That claim is no longer there (forgotten or replaced). Run memory_search to see what is.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = (toolCallId: string) => ({ toolCallId, messages: [] }) as any;

const head = (
  over: Partial<{ id: string; revision: number; statement: string; slotKey: string | null; sensitive: boolean }> = {},
) => ({
  id: "c1",
  revision: 1,
  statement: "The client pays in hryvnia",
  slotKey: null,
  value: null,
  reviewStatus: "confirmed",
  sensitive: false,
  ...over,
});

const make = (over: Partial<Parameters<typeof makeVaultMemoryTools>[0]> = {}) =>
  makeVaultMemoryTools({
    userId: "u1",
    projectId: "p1",
    projectOwnerUserId: "u1",
    messageId: "m1",
    userTurnText: "The client pays in hryvnia, remember that",
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
  listHeadClaims.mockResolvedValue([]);
  proposeCandidate.mockResolvedValue({ state: "auto_active", claimId: "c9", revision: 1 });
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
  it("takes the project space inside a project, files user_direct and a messageId:toolCallId key", async () => {
    const tools = await make();
    expect(await run(tools.memory_propose, { statement: "The client pays in hryvnia" }, "call-7")).toBe("Saved.");

    expect(verifyDirectProvenance).toHaveBeenCalledWith(
      "The client pays in hryvnia",
      "The client pays in hryvnia, remember that",
    );
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "m1:call-7",
        spaceId: PROJECT_SPACE,
        originMessageId: "m1",
        statement: "The client pays in hryvnia",
        provenance: { kind: "user_direct", messageId: "m1" },
        // Without this the reply "added this conversation as evidence" is a lie.
        evidence: [{ messageId: "m1" }],
      }),
    );
  });

  it("outside a project the default is the user space, and a turn mismatch yields derived", async () => {
    verifyDirectProvenance.mockReturnValue(false);
    proposeCandidate.mockResolvedValue({ state: "pending", candidateId: "cand1" });
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });

    expect(await run(tools.memory_propose, { statement: "Favourite colour is blue" })).toBe(
      "Saved as awaiting the user's confirmation.",
    );
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
    // for and then answers "Saved." — a tool result that is not true. Same rule as
    // memory_search: the model asked for a space that does not exist here, so say so
    // instead of substituting one.
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
    proposeCandidate.mockResolvedValue({ state: "merged", claimId: "c2" });
    expect(await run(tools.memory_propose, { statement: "The client pays in hryvnia" })).toBe(
      "Already known — added this conversation as evidence.",
    );
    proposeCandidate.mockResolvedValue({ state: "conflict", candidateId: "cand2" });
    expect(await run(tools.memory_propose, { statement: "The client pays in dollars" })).toBe(
      "Conflicts with an existing fact — recorded for the user to resolve.",
    );
  });
});

describe("memory_update", () => {
  it("success returns the NEW id and revision — a supersede changes the id", async () => {
    updateClaim.mockResolvedValue({ ok: true, id: "c2", revision: 2 });
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "Now in dollars" });

    expect(out).toContain("[c2@2]");
    expect(updateClaim).toHaveBeenCalledWith({
      claimId: "c1",
      expectedRevision: 1,
      patch: { statement: "Now in dollars" },
      allowedSpaceIds: [USER_SPACE, PROJECT_SPACE],
      actor: { kind: "agent" },
    });
  });

  it("the first mismatch is instructive text with the current revision, and no candidate", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4, statement: "In euro" }) });
    findCurrentHead.mockResolvedValue(null);
    const tools = await make();

    expect(await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "In dollars" })).toBe(
      'Claim c5 is now at revision 4: "In euro". Re-issue with expected_revision=4 if the change still applies.',
    );
    expect(proposeCandidate).not.toHaveBeenCalled();
    // The space is needed only by a conflict, and most CAS losses never see a second.
    expect(findCurrentHead).not.toHaveBeenCalled();
  });

  it("a forgotten claim leaks nothing beyond \"it is not there\"", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: null });
    findCurrentHead.mockResolvedValue(null);
    const tools = await make();
    expect(await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "In dollars" })).toBe(
      GONE,
    );
  });

  it("a SECOND mismatch on the same claim files a conflict in the claim's space, keeping sensitivity", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4, sensitive: true }) });
    // The claim was found in the project space, so that is where the conflict lands.
    findCurrentHead.mockResolvedValue(head({ id: "c5", revision: 4 }));
    proposeCandidate.mockResolvedValue({ state: "conflict", candidateId: "cand3" });
    const tools = await make();

    await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "In dollars" }, "call-1");
    expect(proposeCandidate).not.toHaveBeenCalled();

    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 4, statement: "In dollars" }, "call-2");
    expect(out).toBe("Recorded as a conflict for the user to resolve.");
    expect(findCurrentHead).toHaveBeenCalledWith("c1", [PROJECT_SPACE]);
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        forceState: "conflict",
        idempotencyKey: "m1:call-2:conflict",
        spaceId: PROJECT_SPACE,
        statement: "In dollars",
        provenance: { kind: "derived", messageId: "m1" },
        // Sensitivity is a property of the fact; the conflict gate does not replace it.
        sensitive: true,
        evidence: [{ messageId: "m1" }],
      }),
    );
  });

  it("a claim found only in the user space records the conflict THERE", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4 }) });
    // Not in the project space; present in the user space — so the space is known,
    // and it is the user's.
    findCurrentHead.mockImplementation(async (_id: string, spaces: string[]) =>
      spaces[0] === USER_SPACE ? head({ id: "c5", revision: 4 }) : null,
    );
    proposeCandidate.mockResolvedValue({ state: "conflict", candidateId: "cand4" });
    const tools = await make();

    await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "In dollars" }, "call-1");
    await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "In dollars" }, "call-2");
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("a claim in NO reachable space records no conflict at all, and says the claim is gone", async () => {
    // The head vanished (forgotten or superseded) between the CAS loss and the probe.
    // Defaulting to the user space would file a PROJECT-specific fact as global
    // knowledge about the person, and answer "Recorded…" for a space nobody chose.
    // Guessing is strictly worse than declining: an untrue tool result plus a fact in
    // the wrong scope.
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4 }) });
    findCurrentHead.mockResolvedValue(null);
    const tools = await make();

    await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "Now in dollars" }, "call-1");
    const out = await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "Now in dollars" }, "call-2");

    expect(out).toBe(GONE);
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("a second mismatch on a NONEXISTENT claim invents no conflict with nothing", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: null });
    const tools = await make();

    for (const call of ["call-1", "call-2", "call-3"]) {
      expect(
        await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "In dollars" }, call),
      ).toBe(GONE);
    }
    expect(proposeCandidate).not.toHaveBeenCalled();
    expect(findCurrentHead).not.toHaveBeenCalled();
  });

  it("the mismatch mirror lives exactly one turn", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4 }) });
    findCurrentHead.mockResolvedValue(null);
    const first = await make();
    await run(first.memory_update, { claim_id: "c1", expected_revision: 1, statement: "In dollars" });
    // The next turn is a new factory, so this is a FIRST mismatch again.
    const second = await make();
    const out = await run(second.memory_update, { claim_id: "c1", expected_revision: 1, statement: "In dollars" });
    expect(out).toContain("Re-issue with expected_revision=4");
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("broken value_json never reaches the service", async () => {
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, value_json: "[1,]" });
    expect(out).toMatch(/^value_json is not valid JSON: /);
    expect(updateClaim).not.toHaveBeenCalled();
  });

  it("value_json reaches the patch parsed", async () => {
    updateClaim.mockResolvedValue({ ok: true, id: "c2", revision: 2 });
    const tools = await make();
    await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, value_json: '{"days":45}' });
    expect(updateClaim).toHaveBeenCalledWith(expect.objectContaining({ patch: { value: { days: 45 } } }));
  });
});

describe("memory_forget", () => {
  it("forgets, and confirms it", async () => {
    forgetClaim.mockResolvedValue({ ok: true });
    const tools = await make();
    expect(await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1, reason: "out of date" })).toBe(
      "Forgotten.",
    );
    expect(forgetClaim).toHaveBeenCalledWith({
      claimId: "c1",
      expectedRevision: 1,
      allowedSpaceIds: [USER_SPACE, PROJECT_SPACE],
      actor: { kind: "agent" },
      reason: "out of date",
    });
  });

  it("someone else's claim reads as nonexistent and says nothing about itself", async () => {
    forgetClaim.mockResolvedValue({ ok: false, current: null });
    const tools = await make();
    expect(await run(tools.memory_forget, { claim_id: "not-ours", expected_revision: 1 })).toBe(GONE);
  });

  it("the mismatch language is the same as in update", async () => {
    forgetClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 3, statement: "In euro" }) });
    const tools = await make();
    expect(await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1 })).toBe(
      'Claim c5 is now at revision 3: "In euro". Re-issue with expected_revision=3 if the change still applies.',
    );
  });
});

describe("memory_search", () => {
  it("matches a substring in statement OR slot_key and formats id@revision lines", async () => {
    listHeadClaims.mockImplementation(async (spaceId: string) =>
      spaceId === PROJECT_SPACE
        ? [
            head({ id: "c1", revision: 2, statement: "The client pays in Hryvnia" }),
            head({ id: "c2", revision: 1, statement: "Nothing in common", slotKey: "hryvnia/rate" }),
            head({ id: "c3", revision: 1, statement: "Something else entirely" }),
          ]
        : [],
    );
    const tools = await make();
    const out = await run(tools.memory_search, { query: "hryvni" });
    expect(out).toBe("[c1@2] The client pays in Hryvnia\n[c2@1] Nothing in common (slot: hryvnia/rate)");
  });

  it("an empty result is a sentence, not an empty string", async () => {
    const tools = await make();
    expect(await run(tools.memory_search, { query: "nothing" })).toBe("No saved memory matches.");
  });

  it("scope narrows the spaces; the default takes both", async () => {
    listHeadClaims.mockResolvedValue([]);
    const tools = await make();
    await run(tools.memory_search, { query: "x" });
    expect(listHeadClaims.mock.calls.map((c) => c[0])).toEqual([PROJECT_SPACE, USER_SPACE]);

    listHeadClaims.mockClear();
    await run(tools.memory_search, { query: "x", scope: "user" });
    expect(listHeadClaims.mock.calls.map((c) => c[0])).toEqual([USER_SPACE]);
  });

  it("hands back at most 20 lines", async () => {
    listHeadClaims.mockImplementation(async (spaceId: string) =>
      spaceId === PROJECT_SPACE
        ? Array.from({ length: 30 }, (_, i) => head({ id: `c${i}`, statement: `fact ${i}` }))
        : [],
    );
    const tools = await make();
    expect((await run(tools.memory_search, { query: "fact" })).split("\n")).toHaveLength(20);
  });

  it("an overflowing project does not crowd the user space off the list", async () => {
    // Without sharing the ceiling, twenty project matches would leave the user's
    // claims not merely invisible but uncorrectable: the ids for update/forget come
    // from here and nowhere else.
    listHeadClaims.mockImplementation(async (spaceId: string) =>
      Array.from({ length: 30 }, (_, i) =>
        head({ id: `${spaceId === PROJECT_SPACE ? "p" : "u"}${i}`, statement: `fact ${i}` }),
      ),
    );
    const tools = await make();
    const lines = (await run(tools.memory_search, { query: "fact" })).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.filter((l) => l.startsWith("[p"))).toHaveLength(10);
    expect(lines.filter((l) => l.startsWith("[u"))).toHaveLength(10);
  });

  it("outside a project scope:'project' substitutes no space and returns empty", async () => {
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });
    expect(await run(tools.memory_search, { query: "x", scope: "project" })).toBe("No saved memory matches.");
    expect(listHeadClaims).not.toHaveBeenCalled();
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

  it("`.refine` does NOT reach the JSON Schema, so the requirement also lives in the description", async () => {
    const tools = await make();
    const js = asSchema(tools.memory_update.inputSchema).jsonSchema as { required?: string[] };
    // Were refine serialized, there would be some mention of statement/value_json here.
    expect(js.required).toEqual(["claim_id", "expected_revision"]);
    expect(tools.memory_update.description).toContain(
      "At least one of statement/value_json must be provided.",
    );
  });

  it("refine still validates on the server side", async () => {
    const tools = await make();
    const parsed = (tools.memory_update.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      claim_id: "c1",
      expected_revision: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
