import { describe, it, expect } from "vitest";
import { isTransientError } from "@/lib/errors/friendly";

describe("isTransientError", () => {
  it("network drops are transient", () => {
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError(new Error("fetch failed: ECONNRESET"))).toBe(true);
  });
  it("5xx / overload / rate-limit are transient", () => {
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("502 Bad Gateway")).toBe(true);
    expect(isTransientError("Error 529: overloaded")).toBe(true);
    expect(isTransientError("429 rate limit exceeded")).toBe(true);
  });
  it("auth / credits / invalid-request are NOT transient", () => {
    expect(isTransientError("401 invalid api key")).toBe(false);
    expect(isTransientError("402 insufficient credits")).toBe(false);
    expect(isTransientError("400 messages must alternate")).toBe(false);
  });
  it("the payload inside the message never decides it", () => {
    // A gateway that merges parallel tool calls echoes the whole file back at us;
    // the ";500;" of a Google Fonts weight list used to read as a 5xx.
    expect(
      isTransientError(
        new Error(
          'invalid arguments for function write_file, args: "{\\"content\\":\\"<link href=\\\\\\"https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700\\\\\\">\\"}"',
        ),
      ),
    ).toBe(false);
    expect(isTransientError(new Error("Bad request: 500 г курячого фаршу"))).toBe(false);
  });
  it("a structured status outranks the text", () => {
    expect(isTransientError(Object.assign(new Error("capacity of the pan"), { statusCode: 400 }))).toBe(false);
    expect(isTransientError(Object.assign(new Error("nothing quotable here"), { statusCode: 503 }))).toBe(true);
  });
  it("still retries a rate limit in the shape the SDK actually throws", () => {
    // The status check runs BEFORE the `rate_limited` branch, so a 429 that is
    // not covered here stops being retried entirely — and the string assertion
    // above never notices, because a bare string carries no status to find.
    expect(isTransientError(Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("Too Many Requests"), { status: 429 }))).toBe(true);
  });
});
