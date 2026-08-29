import { describe, it, expect, vi, beforeEach } from "vitest";

// candidates.ts owns the ledger's policy; this module is exercised in isolation from
// it, the same way tools.test.ts mocks it — the ledger has its own integration suite.
const { proposeCandidate, verifyDirectProvenance } = vi.hoisted(() => ({
  proposeCandidate: vi.fn(),
  verifyDirectProvenance: vi.fn(),
}));
vi.mock("../candidates", () => ({ proposeCandidate, verifyDirectProvenance }));

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

const generateReturning = (text: string, finishReason = "stop"): GenerateFn =>
  vi.fn().mockResolvedValue({ text, finishReason });

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

describe("extractCandidates — space selection", () => {
  it("files to the project space when one is given", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractCandidates({ ...baseArgs, projectSpaceId: PROJECT_SPACE, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: PROJECT_SPACE }));
  });

  it("files to the user space when there is no project", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
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

describe("extractCandidates — evidence and origin", () => {
  it("attaches the originating message as both originMessageId and evidence", async () => {
    const generate = generateReturning('[{"statement":"pays in EUR","from":"user"}]');
    await extractCandidates({ ...baseArgs, generate });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ originMessageId: MESSAGE_ID, evidence: [{ messageId: MESSAGE_ID }] }),
    );
  });
});
