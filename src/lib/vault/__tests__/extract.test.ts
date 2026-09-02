import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// `claims.ts` owns the two statements that put a row in `vault_claims`; this module is
// exercised in isolation from them, the same way it used to be from the candidate
// ledger. What is deliberately NOT stubbed is `grounding.ts`: `classify` running the
// four clauses over the arm this module picks is the property under test, so a stubbed
// classifier would leave every class assertion below asserting the stub.
const { createClaim, findExactDuplicate, attachEvidence } = vi.hoisted(() => ({
  createClaim: vi.fn(),
  findExactDuplicate: vi.fn(),
  attachEvidence: vi.fn(),
}));
// `fitStatement` and the rest are the real ones: `findExactDuplicate` and `createClaim`
// agree on the dedup key only because both clamp the same way, and a blanket stub here
// would hide that.
vi.mock("../claims", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claims")>()),
  createClaim,
  findExactDuplicate,
  attachEvidence,
}));
// A transaction wrapper with no database behind it. `extract.ts` opens one per item so
// the claim and its evidence land together; this runs the callback and hands the same
// object down as the executor, which is all the mocked writers look at.
vi.mock("@/lib/db", () => ({
  db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }) },
}));

// So the two silent-total-loss branches (finishReason=length, unparseable output)
// can be asserted on directly, and told apart from the legitimate "nothing to
// extract" (`[]`) case, which must NOT log anything.
const { log } = vi.hoisted(() => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/log", () => ({ log }));

import { extractFacts, type GenerateFn } from "../extract";

const USER_SPACE = "space-user";
const PROJECT_SPACE = "space-project";
const MESSAGE_ID = "msg-1";
const TASK_ID = "task-1";

const baseArgs = {
  userSpaceId: USER_SPACE,
  messageId: MESSAGE_ID,
  taskId: TASK_ID,
  userText: "I work in procurement and pay suppliers in EUR",
  assistantText: "Got it, noted.",
  untrustedIngressSeen: false,
};

/** The nth claim this module asked for, as the argument object it was asked with. The
 *  class is decided in `grounding.ts` and PASSED, so the call is where the decision is
 *  observable — this suite deliberately has no database to read a row back from. */
const wrote = (n = 1) =>
  (createClaim.mock.calls[n - 1]?.[0] ?? {}) as {
    spaceId?: string;
    statement?: string;
    slotKey?: string;
    sensitive?: boolean;
    sourceClass?: string;
    origin?: Record<string, unknown>;
    createdTaskId?: string;
    failedClause?: number | null;
  };

// No return-type annotation: callers that need to inspect `.mock.calls` (the
// "what is actually sent to the aux model" tests) rely on the inferred vi.fn()
// type, which is structurally a GenerateFn but keeps the mock's own properties too.
const generateReturning = (text: string, finishReason = "stop") => vi.fn().mockResolvedValue({ text, finishReason });

beforeEach(() => {
  vi.resetAllMocks();
  findExactDuplicate.mockResolvedValue(null);
  createClaim.mockResolvedValue({ id: "c1", revision: 1, sensitive: false });
});

describe("extractFacts — length finishReason bails before parsing", () => {
  it("writes nothing when finishReason is length, even with well-formed-looking output", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]', "length");
    await extractFacts({ ...baseArgs, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(createClaim).not.toHaveBeenCalled();
  });
});

describe("extractFacts — tolerant parsing", () => {
  it("writes nothing when the model output isn't a JSON array", async () => {
    const generate = generateReturning("Sorry, I have nothing to extract here.");
    await extractFacts({ ...baseArgs, generate });
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("writes nothing for an empty array", async () => {
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("extracts the array even when the model wraps it in prose or a code fence", async () => {
    const generate = generateReturning(
      'Sure, here you go:\n```json\n[{"statement":"pays in EUR","from":"user"}]\n```\nHope that helps!',
    );
    await extractFacts({ ...baseArgs, generate });
    expect(createClaim).toHaveBeenCalledTimes(1);
    expect(wrote().statement).toBe("pays in EUR");
  });

  it("skips an item with no statement but keeps the rest independent", async () => {
    const generate = generateReturning(
      '[{"slot_key":"x","from":"user"},{"statement":"pays in EUR","from":"user"}]',
    );
    await extractFacts({ ...baseArgs, generate });
    expect(createClaim).toHaveBeenCalledTimes(1);
    expect(wrote().statement).toBe("pays in EUR");
  });

  it("does not throw and logs when generate resolves with a non-string text", async () => {
    const badGenerate = vi.fn().mockResolvedValue({ text: undefined, finishReason: "stop" }) as unknown as GenerateFn;
    await expect(extractFacts({ ...baseArgs, generate: badGenerate })).resolves.toBeUndefined();
    expect(createClaim).not.toHaveBeenCalled();
  });
});

/**
 * THE CLASS MATRIX, and it runs through the REAL `classify`.
 *
 * This is the whole of Task 14: extraction no longer decides a trust tier of its own. It
 * picks a `Grounding` ARM from the model's own `from`/`quoted` fields and the server runs
 * §4.5 rule 1's four clauses over it, exactly as `memory_fact_write` does. There is
 * therefore no `user_direct` or `agent_inferred` literal in `extract.ts` at all — the
 * guard at the bottom of this file asserts that as a property of the source.
 */
describe("extractFacts — the class comes out of classify, not out of this module", () => {
  it("a direct user statement lands user_direct through the SAME four clauses the tools use", async () => {
    const generate = generateReturning('[{"statement":"Acme is paid monthly","from":"user"}]');
    await extractFacts({
      ...baseArgs,
      userText: "we pay Acme monthly, remember that",
      generate,
    });
    expect(wrote().sourceClass).toBe("user_direct");
    expect(wrote().failedClause).toBeNull();
  });

  it("an assistant conclusion lands agent_inferred", async () => {
    const generate = generateReturning('[{"statement":"the merger closes in March","from":"assistant"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(wrote().sourceClass).toBe("agent_inferred");
  });

  it("a relayed quote lands agent_inferred even when the words are all in the turn", async () => {
    // `quoted: true` is the model saying the user reproduced somebody else's words, so
    // the arm is an inference and clause 4 is never reached. Same answer as the tool
    // path gives for `grounding: { kind: "agent_inference" }`.
    const generate = generateReturning(
      '[{"statement":"pay suppliers in EUR","from":"user","quoted":true}]',
    );
    await extractFacts({ ...baseArgs, generate });
    expect(wrote().sourceClass).toBe("agent_inferred");
  });

  it("a statement the user's own turn does not back lands agent_inferred, with the failed clause for the audit", async () => {
    // Clause 4 is the tie between the statement and the located span. It fails here
    // because none of «lives in Kyiv»'s long words are in the turn, and the failure
    // DEGRADES rather than refusing — the fact is still saved, as a conclusion.
    const generate = generateReturning('[{"statement":"lives in Kyiv","from":"user"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(wrote().sourceClass).toBe("agent_inferred");
    expect(wrote().failedClause).toBe(4);
  });

  it("a turn that touched untrusted ingress lands untrusted_derived, and NOT in the user space", async () => {
    // §4.5 step 3, and it is a REFUSAL rather than a re-scope: a fact learned from a
    // document or a fetched page has no home in personal memory, and widening it into
    // the user space to avoid dropping it is exactly what the fence forbids.
    const generate = generateReturning('[{"statement":"lives in Kyiv","from":"user","scope":"user"}]');
    await extractFacts({ ...baseArgs, untrustedIngressSeen: true, generate });
    expect(createClaim).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/personal memory/i), expect.anything());
  });

  it("the same untrusted turn DOES write to the project space, at untrusted_derived", async () => {
    // The other half of the fence, and why it is a refusal and not a ban: project
    // memory is where knowledge taken from documents belongs.
    const generate = generateReturning('[{"statement":"lives in Kyiv","from":"user","scope":"project"}]');
    await extractFacts({ ...baseArgs, projectSpaceId: PROJECT_SPACE, untrustedIngressSeen: true, generate });
    expect(wrote().spaceId).toBe(PROJECT_SPACE);
    expect(wrote().sourceClass).toBe("untrusted_derived");
  });

  it("a user_direct statement is NOT capped by the turn's taint", async () => {
    // Deliberate, and `grounding.ts` says why: a person who uploads a file and then
    // types their own address in the same turn has still typed their own address. What
    // taint bars is the SUPERSEDE, which is a different decision made by a different
    // caller — extraction never supersedes anything.
    const generate = generateReturning('[{"statement":"Acme is paid monthly","from":"user","scope":"user"}]');
    await extractFacts({
      ...baseArgs,
      userText: "we pay Acme monthly, remember that",
      untrustedIngressSeen: true,
      generate,
    });
    expect(wrote().sourceClass).toBe("user_direct");
    expect(wrote().spaceId).toBe(USER_SPACE);
  });
});

describe("extractFacts — the exact-duplicate check is the crash-retry no-op", () => {
  it("writes nothing when the space already holds the statement letter for letter", async () => {
    // What the candidate ledger's `idempotency_key` used to buy. §4.5 step 4 buys the
    // same thing off `normalized_hash`, so a re-run of a finished extraction — same
    // message, same model output — writes nothing instead of duplicating every fact.
    findExactDuplicate.mockResolvedValue({ id: "already", revision: 1 });
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(findExactDuplicate).toHaveBeenCalledTimes(1);
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("asks about each item separately, so one known fact does not skip the rest", async () => {
    findExactDuplicate.mockResolvedValueOnce({ id: "already", revision: 1 }).mockResolvedValue(null);
    const generate = generateReturning(
      '[{"statement":"fact A","from":"user"},{"statement":"fact B","from":"user"}]',
    );
    await extractFacts({ ...baseArgs, generate });
    expect(createClaim).toHaveBeenCalledTimes(1);
    expect(wrote().statement).toBe("fact B");
  });
});

describe("extractFacts — per-item space selection", () => {
  it("files an item with scope:project to the project space when one is given", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user","scope":"project"}]');
    await extractFacts({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(wrote().spaceId).toBe(PROJECT_SPACE);
  });

  it("DROPS an item asking for scope:project when there is no project space", async () => {
    // The tool path REFUSES this input rather than absorbing it, on the reasoning that
    // the user space is a wider audience than was asked for — a work fact stated in a
    // bare chat would become a permanent fact about the person. The unattended path
    // has nobody to ask, so it drops the item instead; what it must not do is give the
    // same input a different answer, which is the very divergence being closed.
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user","scope":"project"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("files an item with scope:user to the user space even when a project space exists", async () => {
    const generate = generateReturning('[{"statement":"works in procurement","from":"user","scope":"user"}]');
    await extractFacts({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(wrote().spaceId).toBe(USER_SPACE);
  });

  it("defaults an item with no scope field to the PROJECT space, the same as the tool path", async () => {
    // The two writers disagreed about what an absent `scope` means — this module read
    // it as the user space, `memory_propose` as the project one — so the same omitted
    // field filed a fact about one project as a fact about the person, injected into
    // every other project and chat. Least privilege settles it: the narrower audience.
    const generate = generateReturning('[{"statement":"the merger codename is Redwood","from":"user"}]');
    await extractFacts({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(wrote().spaceId).toBe(PROJECT_SPACE);
  });

  it("an unusable scope value is treated as absent, not as 'user'", async () => {
    const generate = generateReturning('[{"statement":"the merger codename is Redwood","from":"user","scope":"team"}]');
    await extractFacts({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(wrote().spaceId).toBe(PROJECT_SPACE);
  });

  it("outside a project everything lands in the user space, scope or no scope", async () => {
    const generate = generateReturning('[{"statement":"works in procurement","from":"user"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(wrote().spaceId).toBe(USER_SPACE);
  });

  it("splits a mixed batch: personal fact to the user space, project fact to the project space", async () => {
    const generate = generateReturning(
      '[{"statement":"works in procurement","from":"user","scope":"user"},' +
        '{"statement":"pays suppliers in EUR","from":"user","scope":"project"}]',
    );
    await extractFacts({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(wrote(1)).toMatchObject({ statement: "works in procurement", spaceId: USER_SPACE });
    expect(wrote(2)).toMatchObject({ statement: "pays suppliers in EUR", spaceId: PROJECT_SPACE });
  });
});

describe("extractFacts — isolation from the caller and from each other", () => {
  it("never throws when the generate call itself rejects", async () => {
    const generate: GenerateFn = vi.fn().mockRejectedValue(new Error("aux model unreachable"));
    await expect(extractFacts({ ...baseArgs, generate })).resolves.toBeUndefined();
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("a failed write logs a shape, never the error text — which carries the statement", async () => {
    // The installed Drizzle embeds every SQL parameter in the error's own message, so
    // `String(e)` writes the statement — a credential included — into the application
    // log and every collector behind it, right after the secret screen kept it out
    // of the prompt. Asserting "something was logged" passes against that bug; this
    // asserts what is IN the payload.
    const secret = "sk-proj-AbCdEf0123456789ghijkl";
    const boom = Object.assign(new Error(`insert into "vault_claims" failed, params: my key is ${secret}`), {
      cause: { code: "23503", constraint: "vault_claims_space_id_fk" },
    });
    createClaim.mockRejectedValue(boom);
    const generate = generateReturning(`[{"statement":"my key is ${secret}","from":"user"}]`);

    await extractFacts({ ...baseArgs, generate });

    expect(log.error).toHaveBeenCalledTimes(1);
    const [message, payload] = log.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(`${message} ${JSON.stringify(payload)}`).not.toContain(secret);
    expect(payload).toMatchObject({ code: "23503", constraint: "vault_claims_space_id_fk", ordinal: 0 });
  });

  it("never throws when the write rejects, and still processes the remaining items", async () => {
    createClaim.mockRejectedValueOnce(new Error("db exploded")).mockResolvedValueOnce({
      id: "c2",
      revision: 1,
      sensitive: false,
    });
    const generate = generateReturning('[{"statement":"fact A","from":"user"},{"statement":"fact B","from":"user"}]');
    await expect(extractFacts({ ...baseArgs, generate })).resolves.toBeUndefined();
    expect(createClaim).toHaveBeenCalledTimes(2);
    expect(wrote(2).statement).toBe("fact B");
  });
});

describe("extractFacts — evidence, origin, and field mapping", () => {
  it("attaches the originating message as evidence, in the claim's own transaction", async () => {
    // The memory page names the conversation a fact came from off `claim_evidence`, so
    // a claim written without it reads as "the conversation is no longer available" on
    // the one screen a person can act from.
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(attachEvidence).toHaveBeenCalledWith("c1", { messageId: MESSAGE_ID }, expect.anything());
  });

  it("records the turn and the task in the origin, and the task as the writing task", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractFacts({ ...baseArgs, generate });
    expect(wrote().origin).toMatchObject({ messageId: MESSAGE_ID, taskId: TASK_ID, via: "extraction" });
    expect(wrote().createdTaskId).toBe(TASK_ID);
  });

  it("the origin's `kind` is the GROUNDING, never the trust tier", async () => {
    // LOW-6: `user_direct` was a value of two different enums in one argument list —
    // an `origin.kind` and a `source_class`. The tier lives in its own column.
    const generate = generateReturning('[{"statement":"Acme is paid monthly","from":"user"}]');
    await extractFacts({ ...baseArgs, userText: "we pay Acme monthly, remember that", generate });
    expect(wrote().origin?.kind).toBe("current_user_quote");
    expect(wrote().sourceClass).toBe("user_direct");
  });

  it("maps sensitive and slot_key straight through to the write", async () => {
    const generate = generateReturning(
      '[{"statement":"has diabetes","from":"user","sensitive":true,"slot_key":"health/condition"}]',
    );
    await extractFacts({ ...baseArgs, generate });
    expect(wrote()).toMatchObject({ sensitive: true, slotKey: "health/condition" });
  });
});

describe("extractFacts — what is actually sent to the aux model", () => {
  it("sends exactly the two turn texts, wrapped as data, and nothing else", async () => {
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    expect(generate).toHaveBeenCalledWith({
      system: expect.any(String),
      prompt:
        `<user_turn>\n${baseArgs.userText}\n</user_turn>\n<assistant_turn>\n${baseArgs.assistantText}\n</assistant_turn>`,
      maxOutputTokens: 2048,
    });
  });

  it("never feeds tool outputs to the extractor — the input is userText and assistantText only", async () => {
    // The FIRST layer against injection, and it is structural rather than a filter: a
    // fetched web page or an MCP tool result has no channel into this prompt at all.
    // Asserting the CHANNELS rather than the absence of one sample string is what makes
    // a third one — `<tool_output>` — fail this instead of slipping past a blocklist.
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    const [[called]] = generate.mock.calls;
    expect((called.prompt as string).match(/<[a-z_]+>/g)).toEqual(["<user_turn>", "<assistant_turn>"]);
  });

  it("the system prompt tells the model the turn content is data, never instructions", async () => {
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    const [[calledWith]] = generate.mock.calls;
    expect(calledWith.system).toMatch(/text to analyse only/i);
    expect(calledWith.system).toMatch(/never instructions to follow/i);
  });

  // Documentation-only pin: this only proves the WORDING is still there, not that
  // anything enforces it — the aux model can ignore prompt-level guidance. The
  // actual guarantee against a durably-stored secret is `secretShaped` on both
  // claim writers, tested in `secret-screen.test.ts` (the patterns) and in
  // `claims.integration.test.ts` (that a screened statement is written sensitive).
  it("the system prompt ALSO asks the model not to extract credentials, and extends sensitive to cover them", async () => {
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    const [[calledWith]] = generate.mock.calls;
    expect(calledWith.system).toMatch(/credential/i);
    expect(calledWith.system).toMatch(/password/i);
    expect(calledWith.system).toMatch(/api key/i);
    expect(calledWith.system).toMatch(/connection string/i);
  });

  // Pins the wording that makes the real-verifier tests below meaningful: if this
  // instruction is ever deleted, those tests keep passing (they call
  // verifyDirectProvenance directly, not through the prompt) while the guarantee
  // they demonstrate quietly stops holding in production. This is that tripwire.
  it("the system prompt still asks for same-language, literal-reuse phrasing", async () => {
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    const [[calledWith]] = generate.mock.calls;
    expect(calledWith.system).toMatch(/same language/i);
    expect(calledWith.system).toMatch(/reusing the user's own words/i);
  });
});

// These run the REAL clause-4 predicate directly, because the property under test is
// exactly whether the prompt's own instruction (reuse the user's wording, don't
// paraphrase) is what makes `user_direct` reachable in practice.
describe("extractFacts — the prompt's guidance against the real clause 4", () => {
  it("a literally-reused Ukrainian statement clears the real verifyDirectProvenance's 60% bar", async () => {
    const real = await vi.importActual<typeof import("../quote-match")>("../quote-match");
    const userTurnText = "Мій постачальник Акме дає відстрочку платежу 30 днів, запам'ятай це";
    // What the prompt asks for: the SAME wording the user used, not a paraphrase.
    const statement = "Постачальник Акме дає відстрочку платежу 30 днів";
    expect(real.verifyDirectProvenance(statement, userTurnText)).toBe(true);
  });

  it("the real verifier matches across a case ending, which whole-word containment could not", async () => {
    const real = await vi.importActual<typeof import("../quote-match")>("../quote-match");
    // `includes` was asymmetric: it found the short form inside the long one and never
    // the reverse, so the same Ukrainian fact verified or not depending on which case
    // form the model happened to write. Only "акме" survives whole-word containment
    // here (1 of 4, well under the 60% bar); on shared prefixes three of four match.
    const userTurnText = "Ми платимо постачальнику Акме щомісяця";
    expect(real.verifyDirectProvenance("Оплата постачальника Акме щомісячна", userTurnText)).toBe(true);

    // And the other direction, which is the one that costs: at five characters
    // "переказ" and "переклад" share a prefix and the filter would confirm a
    // statement the user did not make. Only "підтверджено" matches here, 1 of 2.
    expect(real.verifyDirectProvenance("Переказ підтверджено", "Переклад підтверджено")).toBe(false);
  });

  it("a paraphrase into different wording — what the old prompt's example modelled — fails the real verifier", async () => {
    const real = await vi.importActual<typeof import("../quote-match")>("../quote-match");
    const userTurnText = "Мій постачальник Акме дає відстрочку платежу 30 днів, запам'ятай це";
    const paraphrased = "The supplier grants a one-month payment deferral";
    expect(real.verifyDirectProvenance(paraphrased, userTurnText)).toBe(false);
  });
});

describe("extractFacts — the two total-loss branches log, an empty result does not", () => {
  it("logs a warning on finishReason=length", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]', "length");
    await extractFacts({ ...baseArgs, generate });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/length/i), { messageId: MESSAGE_ID });
  });

  it("logs a warning when the output can't be parsed as a JSON array", async () => {
    const generate = generateReturning("not json at all, sorry");
    await extractFacts({ ...baseArgs, generate });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/parseable JSON array/i), { messageId: MESSAGE_ID });
  });

  it("does NOT log a warning for a legitimate empty array — that is a normal outcome, not a failure", async () => {
    const generate = generateReturning("[]");
    await extractFacts({ ...baseArgs, generate });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

/**
 * NOTHING IN `src/` PRODUCES A CANDIDATE ANY MORE, as a property of the source tree.
 *
 * A mock-based "was it called" assertion cannot say this: it answers for the one module
 * the mock is mounted in, and §11.8's claim is about every writer at once — the tool
 * surface, the boot migration and this module. `proposeCandidate` keeps its exported
 * existence for the archive's confirm path, so its absence cannot be asserted by
 * deleting it; it is asserted by nobody calling it.
 */
const PRODUCTION_ROOT = "src";

/** Comments out. Crude on purpose — it can also blank a `//` inside a string literal,
 *  which for these two questions only ever makes the guard STRICTER (a name hidden in a
 *  string is not code either). */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

function productionFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "eval") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) out.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(PRODUCTION_ROOT);
  return out;
}

describe("the candidate ledger has no producer left", () => {
  const files = productionFiles();

  it("scans the source tree at all", () => {
    // The control: an empty scan finds no producer and passes for the wrong reason.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.path.endsWith(join("vault", "candidates.ts")))).toBe(true);
  });

  it("names `proposeCandidate` in candidates.ts alone, outside comments", () => {
    // CODE, not prose. Two files legitimately explain why the ledger has no producer
    // left, and a guard that condemned an explanation would be answered by deleting the
    // explanation. So comments come off first and the name is then looked for in what
    // remains — which covers an import binding and a call alike, without either being
    // enumerated as a shape somebody can write around.
    const others = files
      .filter((f) => !f.path.endsWith(join("vault", "candidates.ts")))
      .filter((f) => /\bproposeCandidate\b/.test(stripComments(f.text)))
      .map((f) => f.path);
    expect(others).toEqual([]);
  });

  it("has no `user_direct` or `agent_inferred` literal in extract.ts — the class comes from classify", () => {
    const extract = files.find((f) => f.path.endsWith(join("vault", "extract.ts")));
    expect(extract).toBeDefined();
    expect(extract!.text).not.toMatch(/["']user_direct["']/);
    expect(extract!.text).not.toMatch(/["']agent_inferred["']/);
    // `untrusted_derived` is deliberately NOT on that list, and the difference is the
    // one this guard exists to keep visible: those two are classes this module would be
    // ASSIGNING, while §4.5 step 3's fence has to READ the class the server computed.
    // `write-tools.ts` compares against the same literal for the same reason, and it is
    // the only occurrence here.
    expect(extract!.text.match(/["']untrusted_derived["']/g)).toHaveLength(1);
  });
});
