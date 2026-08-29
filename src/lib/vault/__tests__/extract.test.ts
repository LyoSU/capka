import { describe, it, expect, vi, beforeEach } from "vitest";

// candidates.ts owns the ledger's policy; this module is exercised in isolation from
// it, the same way tools.test.ts mocks it — the ledger has its own integration suite.
const { proposeCandidate, verifyDirectProvenance } = vi.hoisted(() => ({
  proposeCandidate: vi.fn(),
  verifyDirectProvenance: vi.fn(),
}));
vi.mock("../candidates", () => ({ proposeCandidate, verifyDirectProvenance }));

// So the two silent-total-loss branches (finishReason=length, unparseable output)
// can be asserted on directly, and told apart from the legitimate "nothing to
// extract" (`[]`) case, which must NOT log anything.
const { log } = vi.hoisted(() => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/log", () => ({ log }));

import { extractCandidates, type GenerateFn } from "../extract";

const USER_SPACE = "space-user";
const PROJECT_SPACE = "space-project";
const MESSAGE_ID = "msg-1";

const baseArgs = {
  userSpaceId: USER_SPACE,
  messageId: MESSAGE_ID,
  userText: "I work in procurement and pay suppliers in EUR",
  assistantText: "Got it, noted.",
};

// No return-type annotation: callers that need to inspect `.mock.calls` (the
// "what is actually sent to the aux model" tests) rely on the inferred vi.fn()
// type, which is structurally a GenerateFn but keeps the mock's own properties too.
const generateReturning = (text: string, finishReason = "stop") => vi.fn().mockResolvedValue({ text, finishReason });

beforeEach(() => {
  vi.resetAllMocks();
  verifyDirectProvenance.mockReturnValue(true);
  proposeCandidate.mockResolvedValue({ state: "auto_active", claimId: "c1", revision: 1 });
});

describe("extractCandidates — length finishReason bails before parsing", () => {
  it("proposes nothing when finishReason is length, even with well-formed-looking output", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]', "length");
    await extractCandidates({ ...baseArgs, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(proposeCandidate).not.toHaveBeenCalled();
  });
});

describe("extractCandidates — tolerant parsing", () => {
  it("proposes nothing when the model output isn't a JSON array", async () => {
    const generate = generateReturning("Sorry, I have nothing to extract here.");
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("proposes nothing for an empty array", async () => {
    const generate = generateReturning("[]");
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("extracts the array even when the model wraps it in prose or a code fence", async () => {
    const generate = generateReturning(
      'Sure, here you go:\n```json\n[{"statement":"pays in EUR","from":"user"}]\n```\nHope that helps!',
    );
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledTimes(1);
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ statement: "pays in EUR" }));
  });

  it("skips an item with no statement but keeps the rest independent", async () => {
    const generate = generateReturning(
      '[{"slot_key":"x","from":"user"},{"statement":"pays in EUR","from":"user"}]',
    );
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledTimes(1);
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ statement: "pays in EUR", idempotencyKey: `${MESSAGE_ID}:extract:1` }),
    );
  });

  it("does not throw and logs when generate resolves with a non-string text", async () => {
    const badGenerate = vi.fn().mockResolvedValue({ text: undefined, finishReason: "stop" }) as unknown as GenerateFn;
    await expect(extractCandidates({ ...baseArgs, generate: badGenerate })).resolves.toBeUndefined();
    expect(proposeCandidate).not.toHaveBeenCalled();
  });
});

describe("extractCandidates — provenance matrix", () => {
  it("from:user, not quoted, confirmed against userText -> user_direct", async () => {
    verifyDirectProvenance.mockReturnValue(true);
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(verifyDirectProvenance).toHaveBeenCalledWith("pays in EUR", baseArgs.userText);
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { kind: "user_direct", messageId: MESSAGE_ID } }),
    );
  });

  it("from:user, quoted -> derived, without even consulting verifyDirectProvenance", async () => {
    verifyDirectProvenance.mockReturnValue(true);
    const generate = generateReturning('[{"statement":"discount ends in March","from":"user","quoted":true}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(verifyDirectProvenance).not.toHaveBeenCalled();
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { kind: "derived", messageId: MESSAGE_ID } }),
    );
  });

  it("from:assistant -> derived, without even consulting verifyDirectProvenance", async () => {
    const generate = generateReturning('[{"statement":"noted the request","from":"assistant"}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(verifyDirectProvenance).not.toHaveBeenCalled();
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { kind: "derived", messageId: MESSAGE_ID } }),
    );
  });

  it("from:user but the statement isn't actually backed by userText -> derived", async () => {
    verifyDirectProvenance.mockReturnValue(false);
    const generate = generateReturning('[{"statement":"lives in Kyiv","from":"user"}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(verifyDirectProvenance).toHaveBeenCalledWith("lives in Kyiv", baseArgs.userText);
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { kind: "derived", messageId: MESSAGE_ID } }),
    );
  });
});

// These bypass the module mock above to run the REAL policy function from
// candidates.ts, because the property under test is exactly whether the prompt's
// own instruction (reuse the user's wording, don't paraphrase) is what makes
// `user_direct` reachable in practice — a mocked verifier can't show that.
describe("extractCandidates — the prompt's guidance against the real verifier", () => {
  it("a literally-reused Ukrainian statement clears the real verifyDirectProvenance's 60% bar", async () => {
    const real = await vi.importActual<typeof import("../candidates")>("../candidates");
    const userTurnText = "Мій постачальник Акме дає відстрочку платежу 30 днів, запам'ятай це";
    // What the rewritten prompt now asks for: the SAME wording the user used, not a
    // paraphrase — this is exactly the property the prompt fix must produce.
    const statement = "Постачальник Акме дає відстрочку платежу 30 днів";
    expect(real.verifyDirectProvenance(statement, userTurnText)).toBe(true);
  });

  it("a paraphrase into different wording — what the old prompt's example modelled — fails the real verifier", async () => {
    const real = await vi.importActual<typeof import("../candidates")>("../candidates");
    const userTurnText = "Мій постачальник Акме дає відстрочку платежу 30 днів, запам'ятай це";
    const paraphrased = "The supplier grants a one-month payment deferral";
    expect(real.verifyDirectProvenance(paraphrased, userTurnText)).toBe(false);
  });
});

describe("extractCandidates — idempotency keys", () => {
  it("keys each item by its ordinal in the parsed array, stable across a re-run", async () => {
    const output = '[{"statement":"fact A","from":"user"},{"statement":"fact B","from":"user"}]';
    const first = generateReturning(output);
    await extractCandidates({ ...baseArgs, generate: first });
    expect(proposeCandidate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: `${MESSAGE_ID}:extract:0`, statement: "fact A" }),
    );
    expect(proposeCandidate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: `${MESSAGE_ID}:extract:1`, statement: "fact B" }),
    );

    // A re-run after a crash: same message, same model output. The keys must be
    // byte-identical so the ledger's unique index turns this into a no-op.
    vi.clearAllMocks();
    verifyDirectProvenance.mockReturnValue(true);
    proposeCandidate.mockResolvedValue({ state: "duplicate" });
    const second = generateReturning(output);
    await extractCandidates({ ...baseArgs, generate: second });
    expect(proposeCandidate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: `${MESSAGE_ID}:extract:0` }),
    );
    expect(proposeCandidate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: `${MESSAGE_ID}:extract:1` }),
    );
  });
});

describe("extractCandidates — per-item space selection", () => {
  it("files an item with scope:project to the project space when one is given", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user","scope":"project"}]');
    await extractCandidates({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: PROJECT_SPACE }));
  });

  it("files an item with scope:project to the user space when there is no project space", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user","scope":"project"}]');
    await extractCandidates({ ...baseArgs, generate }); // no projectSpaceId
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("files an item with scope:user to the user space even when a project space exists", async () => {
    const generate = generateReturning('[{"statement":"works in procurement","from":"user","scope":"user"}]');
    await extractCandidates({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("defaults an item with no scope field to the user space, even inside a project", async () => {
    const generate = generateReturning('[{"statement":"works in procurement","from":"user"}]');
    await extractCandidates({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("splits a mixed batch: personal fact to the user space, project fact to the project space", async () => {
    const generate = generateReturning(
      '[{"statement":"works in procurement","from":"user","scope":"user"},' +
        '{"statement":"pays suppliers in EUR","from":"user","scope":"project"}]',
    );
    await extractCandidates({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(proposeCandidate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ statement: "works in procurement", spaceId: USER_SPACE }),
    );
    expect(proposeCandidate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ statement: "pays suppliers in EUR", spaceId: PROJECT_SPACE }),
    );
  });
});

describe("extractCandidates — isolation from the caller and from each other", () => {
  it("never throws when the generate call itself rejects", async () => {
    const generate: GenerateFn = vi.fn().mockRejectedValue(new Error("aux model unreachable"));
    await expect(extractCandidates({ ...baseArgs, generate })).resolves.toBeUndefined();
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("never throws when proposeCandidate rejects, and still processes the remaining items", async () => {
    proposeCandidate.mockRejectedValueOnce(new Error("db exploded")).mockResolvedValueOnce({
      state: "auto_active",
      claimId: "c2",
      revision: 1,
    });
    const generate = generateReturning('[{"statement":"fact A","from":"user"},{"statement":"fact B","from":"user"}]');
    await expect(extractCandidates({ ...baseArgs, generate })).resolves.toBeUndefined();
    expect(proposeCandidate).toHaveBeenCalledTimes(2);
    expect(proposeCandidate).toHaveBeenNthCalledWith(2, expect.objectContaining({ statement: "fact B" }));
  });
});

describe("extractCandidates — evidence, origin, and field mapping", () => {
  it("attaches the originating message as both originMessageId and evidence", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ originMessageId: MESSAGE_ID, evidence: [{ messageId: MESSAGE_ID }] }),
    );
  });

  it("maps sensitive and slot_key straight through to proposeCandidate", async () => {
    const generate = generateReturning(
      '[{"statement":"has diabetes","from":"user","sensitive":true,"slot_key":"health/condition"}]',
    );
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ sensitive: true, slotKey: "health/condition" }),
    );
  });
});

describe("extractCandidates — what is actually sent to the aux model", () => {
  it("sends exactly the two turn texts, wrapped as data, and nothing else", async () => {
    const generate = generateReturning("[]");
    await extractCandidates({ ...baseArgs, generate });
    expect(generate).toHaveBeenCalledWith({
      system: expect.any(String),
      prompt:
        `<user_turn>\n${baseArgs.userText}\n</user_turn>\n<assistant_turn>\n${baseArgs.assistantText}\n</assistant_turn>`,
      maxOutputTokens: 2048,
    });
  });

  it("the system prompt tells the model the turn content is data, never instructions", async () => {
    const generate = generateReturning("[]");
    await extractCandidates({ ...baseArgs, generate });
    const [[calledWith]] = generate.mock.calls;
    expect(calledWith.system).toMatch(/text to analyse only/i);
    expect(calledWith.system).toMatch(/never instructions to follow/i);
  });

  // Documentation-only pin: this only proves the WORDING is still there, not that
  // anything enforces it — the aux model can ignore prompt-level guidance. The
  // actual guarantee against a durably-stored secret is `looksLikeSecret`, tested
  // behaviourally below in "secret-shaped statements are never auto-activated".
  it("the system prompt ALSO asks the model not to extract credentials, and extends sensitive to cover them", async () => {
    const generate = generateReturning("[]");
    await extractCandidates({ ...baseArgs, generate });
    const [[calledWith]] = generate.mock.calls;
    expect(calledWith.system).toMatch(/credential/i);
    expect(calledWith.system).toMatch(/password/i);
    expect(calledWith.system).toMatch(/api key/i);
    expect(calledWith.system).toMatch(/connection string/i);
  });

  // Pins the wording that makes the I2 real-verifier tests above meaningful: if
  // this instruction is ever deleted, those tests keep passing (they call
  // verifyDirectProvenance directly, not through the prompt) while the guarantee
  // they demonstrate quietly stops holding in production. This is that tripwire.
  it("the system prompt still asks for same-language, literal-reuse phrasing", async () => {
    const generate = generateReturning("[]");
    await extractCandidates({ ...baseArgs, generate });
    const [[calledWith]] = generate.mock.calls;
    expect(calledWith.system).toMatch(/same language/i);
    expect(calledWith.system).toMatch(/reusing the user's own words/i);
  });
});

describe("extractCandidates — secret-shaped statements are never auto-activated", () => {
  // Driven end-to-end through extractCandidates to the resulting proposeCandidate
  // call, per the review: asserting on the OUTCOME (sensitive forced true), not on
  // words present in the prompt string. The model is made to say `sensitive:false`
  // on purpose in each case, to prove the code — not the model's own honesty —
  // is what forces the gate.
  it("a Postgres connection string with an inline password is forced sensitive", async () => {
    const generate = generateReturning(
      JSON.stringify([
        {
          statement: "our db is postgresql://svcuser:Sup3rSecretPW9!@db.internal:5432/prod",
          from: "user",
          sensitive: false,
        },
      ]),
    );
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
  });

  it("an sk--prefixed API token is forced sensitive", async () => {
    const generate = generateReturning(
      JSON.stringify([{ statement: "here is my API key sk-ABC123XYZ7890DEF456GHI", from: "user", sensitive: false }]),
    );
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
  });

  it("a PEM private-key block is forced sensitive", async () => {
    const generate = generateReturning(
      JSON.stringify([
        {
          statement: "-----BEGIN RSA PRIVATE KEY-----\nMIIExampleNotARealKey==\n-----END RSA PRIVATE KEY-----",
          from: "user",
          sensitive: false,
        },
      ]),
    );
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
  });

  it("does not flag an ordinary fact — the screen is not so broad it eats normal usage", async () => {
    const generate = generateReturning('[{"statement":"pays suppliers in EUR","from":"user","sensitive":false}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ sensitive: false }));
  });
});

describe("extractCandidates — the two total-loss branches log, an empty result does not", () => {
  it("logs a warning on finishReason=length", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]', "length");
    await extractCandidates({ ...baseArgs, generate });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/length/i), { messageId: MESSAGE_ID });
  });

  it("logs a warning when the output can't be parsed as a JSON array", async () => {
    const generate = generateReturning("not json at all, sorry");
    await extractCandidates({ ...baseArgs, generate });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/parseable JSON array/i), { messageId: MESSAGE_ID });
  });

  it("does NOT log a warning for a legitimate empty array — that is a normal outcome, not a failure", async () => {
    const generate = generateReturning("[]");
    await extractCandidates({ ...baseArgs, generate });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
