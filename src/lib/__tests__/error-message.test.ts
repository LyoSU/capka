import { describe, it, expect } from "vitest";
import { errorText } from "@/lib/errors/message";
import { classifyLLMError } from "@/lib/errors/friendly";

describe("errorText", () => {
  it("returns an Error's message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("passes strings through unchanged", () => {
    expect(errorText("plain string error")).toBe("plain string error");
  });

  it("never returns [object Object] for plain objects", () => {
    const out = errorText({ message: "rate limit exceeded", code: 429 });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("rate limit exceeded");
  });

  it("digs the message out of the nested provider shape { error: { message } }", () => {
    const providerPayload = { error: { message: "402 insufficient credits", type: "billing" } };
    expect(errorText(providerPayload)).toContain("402 insufficient credits");
  });

  it("falls back to JSON, not String, for shapes with no message", () => {
    const out = errorText({ weird: true, nested: { code: 7 } });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("7");
  });

  it("returns empty string for null/undefined", () => {
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
  });
});

// The real payoff: object-shaped provider errors must still classify correctly.
// This is exactly the shark-image failure — an object error that used to become
// "[object Object]" and fall through to the "unknown" category.
describe("classifyLLMError with object-shaped errors", () => {
  it("classifies an object payload carrying a 402, instead of falling to unknown", () => {
    const r = classifyLLMError({ error: { message: "402 insufficient credits" } });
    expect(r.category).toBe("out_of_credits");
    expect(r.adminDetail).not.toContain("[object Object]");
  });
});
