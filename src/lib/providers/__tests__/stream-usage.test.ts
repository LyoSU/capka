import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { streamUsageEnabled, disableStreamUsage, withoutStreamUsage } from "../stream-usage";

/**
 * Each test uses a fresh connection id, so the process-wide memory of "this
 * endpoint refuses the ask" needs no reset hook and no test-only export.
 */
const conn = () => randomUUID();

afterEach(() => {
  delete process.env.CAPKA_STREAM_USAGE;
});

describe("streamUsageEnabled", () => {
  it("asks for token counts by default — a working endpoint should not need configuring", () => {
    expect(streamUsageEnabled(conn())).toBe(true);
  });

  it("stops asking once an endpoint has refused", () => {
    const key = conn();
    expect(disableStreamUsage(key)).toBe(true);
    expect(streamUsageEnabled(key)).toBe(false);
  });

  it("keeps the refusal to the one connection that refused", () => {
    const refused = conn();
    const other = conn();
    disableStreamUsage(refused);
    expect(streamUsageEnabled(other)).toBe(true);
  });

  it("reports a second disable as no change, so a retry cannot loop", () => {
    // The runner's retry is gated on this return value: the first rejection
    // launches one re-stream, a rejection that survives it must surface instead
    // of re-streaming forever.
    const key = conn();
    disableStreamUsage(key);
    expect(disableStreamUsage(key)).toBe(false);
  });

  it("honours the operator's off switch, and never learns while it is off", () => {
    // The escape hatch for a backend that breaks on the ask in a way the error
    // classifier does not recognize.
    process.env.CAPKA_STREAM_USAGE = "false";
    const key = conn();
    expect(streamUsageEnabled(key)).toBe(false);
    expect(disableStreamUsage(key)).toBe(false);
  });
});

describe("withoutStreamUsage", () => {
  // This is wired as the SDK's transformRequestBody: it only ever REMOVES the
  // field. `stream_options` is inserted by the SDK on the streaming path alone,
  // so stripping (rather than adding) is what keeps a non-streaming request from
  // ever carrying a parameter that only makes sense on a stream.
  const body = () => ({ model: "m", stream: true, stream_options: { include_usage: true } });

  it("leaves the request untouched while the endpoint is trusted", () => {
    expect(withoutStreamUsage(conn(), body())).toEqual(body());
  });

  it("removes the ask after the endpoint refused it", () => {
    const key = conn();
    disableStreamUsage(key);
    const out = withoutStreamUsage(key, body());
    expect("stream_options" in out).toBe(false);
    expect(out).toEqual({ model: "m", stream: true });
  });

  it("removes the ask when the operator switched it off", () => {
    process.env.CAPKA_STREAM_USAGE = "false";
    expect("stream_options" in withoutStreamUsage(conn(), body())).toBe(false);
  });

  it("passes a body that never carried the field through unchanged", () => {
    const key = conn();
    disableStreamUsage(key);
    expect(withoutStreamUsage(key, { model: "m" })).toEqual({ model: "m" });
  });
});
