import { describe, it, expect } from "vitest";
import { storedPartSchema } from "../contracts";

describe("storedPartSchema tool-call answer marker", () => {
  it("accepts an ask tool-call awaiting an answer", () => {
    const r = storedPartSchema.safeParse({
      type: "tool-call", id: "c1", name: "ask", input: {},
      answer: { form: { fields: [{ id: "q", label: "Q?", kind: "text" }] } },
    });
    expect(r.success).toBe(true);
  });
  it("accepts an answered ask tool-call", () => {
    const r = storedPartSchema.safeParse({
      type: "tool-call", id: "c1", name: "ask", input: {},
      answer: { form: { fields: [{ id: "q", label: "Q?", kind: "text" }] }, value: { action: "submit", values: { q: "hi" } } },
    });
    expect(r.success).toBe(true);
  });
});
