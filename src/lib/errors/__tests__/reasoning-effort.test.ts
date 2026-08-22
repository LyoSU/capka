import { describe, it, expect } from "vitest";
import { parseAllowedEfforts, isReasoningUnsupportedError, isReasoningEchoRejectedError } from "@/lib/errors/friendly";

// Real rejection text. The point of this classifier is that there is no
// machine-readable signal to use instead: Moonshot returns
// `{"message":"reasoning_effort must be low, high, or max","type":"invalid_request_error","param":"","code":null}`
// — an EMPTY `param` — so the accepted set only exists in the prose.
describe("parseAllowedEfforts", () => {
  it("reads Moonshot/Kimi's enum (verified live against the gateway)", () => {
    expect(parseAllowedEfforts(new Error("reasoning_effort must be low, high, or max"))).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("reads Groq's 'one of' phrasing", () => {
    expect(parseAllowedEfforts(new Error("reasoning_effort must be one of none or default"))).toEqual([
      "none",
      "default",
    ]);
  });

  it("reads OpenAI's phrasing without collecting the REJECTED value", () => {
    // "Invalid value: 'medium'" must not leak into the accepted set — retrying
    // with the value the model just refused would loop the turn.
    const err = new Error(
      "400 Invalid value: 'medium'. Supported values are: 'low' and 'high'. (param: reasoning_effort)",
    );
    expect(parseAllowedEfforts(err)).toEqual(["low", "high"]);
  });

  it("handles a colon-delimited list and odd spacing", () => {
    expect(parseAllowedEfforts(new Error("reasoning effort: allowed values are:  minimal , low ,high"))).toEqual([
      "minimal",
      "low",
      "high",
    ]);
  });

  it("ignores an error about a DIFFERENT parameter", () => {
    expect(parseAllowedEfforts(new Error("temperature must be one of 0 or 1"))).toBeNull();
    expect(parseAllowedEfforts(new Error("service_tier must be one of auto or default"))).toBeNull();
  });

  it("does NOT fire on DeepSeek's opposite demand about reasoning_content", () => {
    // The field name is similar and the phrasing contains "must be", but this
    // error means "give the reasoning BACK", not "pick another level". Retrying
    // with a different effort would loop the turn, so it must fall through to the
    // echo classifier instead.
    const err = new Error("reasoning_content must be passed back in the assistant message");
    expect(parseAllowedEfforts(err)).toBeNull();
  });

  it("does not act on a single value quoted back at us", () => {
    // Not an enumeration — probably the rejected value itself. Pinning the model
    // to it would be worse than falling through to the drop-reasoning retry.
    expect(parseAllowedEfforts(new Error("reasoning_effort must be low"))).toBeNull();
  });

  it("returns null for a plain unsupported-parameter rejection", () => {
    // gpt-4o and friends: no enum offered, so there is nothing to negotiate with.
    // This is the existing drop-reasoning path's job, and it still recognizes it.
    const err = new Error("Unsupported parameter: 'reasoning_effort' is not supported with this model.");
    expect(parseAllowedEfforts(err)).toBeNull();
    expect(isReasoningUnsupportedError(err)).toBe(true);
  });

  it("recognizes LiteLLM's gateway phrasing, verbatim from the demo", () => {
    // The exact message that made a demo model pay a rejected request and a full
    // stream restart on every turn. Pinned because the phrasing is the gateway's,
    // not the provider's: no quoted parameter, the name inside a list, and the
    // verb split across "UnsupportedParamsError" and "does not support".
    const err = new Error(
      "litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort'], for model=stealth/ox-alpha. To drop these, set `litellm.drop_params=True`",
    );
    expect(isReasoningUnsupportedError(err)).toBe(true);
    // No enum on offer, so there is nothing to negotiate — it must take the
    // drop-reasoning branch, which is the one that now remembers.
    expect(parseAllowedEfforts(err)).toBeNull();
  });

  it("catches what the old classifier misses — the bug this fixes", () => {
    // The reason a Kimi turn showed a red error panel instead of an answer: the
    // enum rejection matches NEITHER of the existing classifiers, so no retry ran.
    const err = new Error("reasoning_effort must be low, high, or max");
    expect(isReasoningUnsupportedError(err)).toBe(false);
    expect(isReasoningEchoRejectedError(err)).toBe(false);
    expect(parseAllowedEfforts(err)).not.toBeNull();
  });
});
