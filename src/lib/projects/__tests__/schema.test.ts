import { describe, it, expect } from "vitest";
import { projectCreateSchema, projectUpdateSchema } from "@/lib/projects/schema";

describe("project schema", () => {
  it("trims the name and defaults sandboxNetwork", () => {
    const r = projectCreateSchema.parse({ name: "  My project  " });
    expect(r.name).toBe("My project");
    expect(r.sandboxNetwork).toBe("none");
  });

  it("rejects a whitespace-only name (would be an empty project)", () => {
    expect(() => projectCreateSchema.parse({ name: "   " })).toThrow();
  });

  it("rejects a missing name on create", () => {
    expect(() => projectCreateSchema.parse({})).toThrow();
  });

  it("enforces length limits", () => {
    expect(() => projectCreateSchema.parse({ name: "a".repeat(201) })).toThrow();
    expect(() => projectCreateSchema.parse({ name: "ok", description: "d".repeat(2001) })).toThrow();
    expect(() => projectCreateSchema.parse({ name: "ok", systemPrompt: "s".repeat(20001) })).toThrow();
  });

  it("rejects a non-string name (PUT with garbage)", () => {
    expect(() => projectUpdateSchema.parse({ name: 123 as unknown as string })).toThrow();
  });

  it("allows a partial update (PUT) with only some fields", () => {
    const r = projectUpdateSchema.parse({ description: "just this" });
    expect(r.description).toBe("just this");
    expect(r.name).toBeUndefined();
  });

  it("keeps an off-catalog defaultModel (stealth ids are supported)", () => {
    const r = projectCreateSchema.parse({ name: "p", defaultModel: "some/stealth-model-x" });
    expect(r.defaultModel).toBe("some/stealth-model-x");
  });
});
