import { describe, it, expect } from "vitest";
import { isStreamUsageRejectedError } from "@/lib/errors/friendly";

/**
 * `stream_options: {include_usage: true}` is how an OpenAI-compatible endpoint is
 * asked to report token counts on a stream — without it many gateways stream a
 * reply and report no usage at all, so the turn is billed as zero. But the
 * parameter is NOT universally accepted: strict proxies and several first-party
 * OpenAI-compatible APIs reject an unknown body field outright. These are the
 * wordings reported against real backends; each must trigger a retry without the
 * ask instead of failing the user's turn.
 */
describe("isStreamUsageRejectedError", () => {
  it("matches an OpenAI-style unknown-argument rejection", () => {
    expect(isStreamUsageRejectedError("Unrecognized request argument supplied: stream_options")).toBe(true);
  });

  it("matches a proxy that names the parameter in a structured error", () => {
    expect(
      isStreamUsageRejectedError(
        '{"error":{"message":"Unknown parameter: \'stream_options\'.","type":"invalid_request_error","param":"stream_options","code":"unknown_parameter"}}',
      ),
    ).toBe(true);
  });

  it("matches a pydantic-validated gateway (Azure 'on your data', Mistral 422)", () => {
    expect(
      isStreamUsageRejectedError(
        '{"detail":[{"type":"extra_forbidden","loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]}',
      ),
    ).toBe(true);
  });

  it("matches a model-level refusal (xAI Grok, Databricks gateway)", () => {
    expect(isStreamUsageRejectedError("Argument not supported on this model: stream_options")).toBe(true);
    expect(isStreamUsageRejectedError(new Error("Bad Request: stream_options is not supported"))).toBe(true);
  });

  it("matches when only the inner flag is named", () => {
    expect(isStreamUsageRejectedError("include_usage is not allowed")).toBe(true);
  });

  it("does NOT match a rejection of some other parameter", () => {
    // The wording is nearly identical — only the field name separates them, which
    // is why the field is required and a bare 'unknown argument' is not enough.
    expect(isStreamUsageRejectedError("Unrecognized request argument supplied: reasoning_effort")).toBe(false);
    expect(isStreamUsageRejectedError("property 'messages.4.assistant.reasoning_content' is unsupported")).toBe(false);
  });

  it("does NOT match a mention of usage with no rejection in it", () => {
    // A backend that merely reports usage, or an error that quotes the body back
    // for an unrelated reason, must not cost us token reporting forever.
    expect(isStreamUsageRejectedError('{"stream_options":{"include_usage":true}}')).toBe(false);
  });

  it("does NOT match unrelated failures", () => {
    expect(isStreamUsageRejectedError("401 invalid api key")).toBe(false);
    expect(isStreamUsageRejectedError("This model's maximum context length is 128000 tokens")).toBe(false);
    expect(isStreamUsageRejectedError(undefined)).toBe(false);
  });
});
