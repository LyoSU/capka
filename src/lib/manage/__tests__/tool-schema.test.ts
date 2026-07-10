import { describe, it, expect } from "vitest";
import { asSchema } from "ai";
import { makeManageTool } from "../tool";

// The model can only fill `args` (repo/content/path for skills, name+url for mcp,
// …) if the tool's MODEL-FACING JSON Schema leaves that object OPEN. The AI SDK
// serializes the tool via `asSchema` (draft-07) before shipping it to the
// provider — and a `z.record(z.string(), z.unknown())` collapses to
// `additionalProperties: false` down that path, silently forbidding every key
// (the "can't install a skill" bug). These assertions pin the SERIALIZED shape
// the provider actually sees, not the collections' server-side `safeParse`
// (which was already correct and never caught this).
describe("manage tool model-facing JSON Schema", () => {
  const jsonSchema = () => {
    const { manage } = makeManageTool({ userId: "u1", isAdmin: false, projectId: null });
    return asSchema(manage.inputSchema).jsonSchema as {
      properties: Record<string, { type?: string; enum?: string[]; additionalProperties?: unknown; propertyNames?: unknown }>;
      required?: string[];
      additionalProperties?: unknown;
    };
  };

  it("leaves `args` open so the model can pass add fields (repo/content/path/…)", () => {
    const args = jsonSchema().properties.args;
    expect(args.type).toBe("object");
    // `false` = no key allowed (the bug). Absent or `{}`/`true` = open.
    expect(args.additionalProperties).not.toBe(false);
    // The broken conversion also emitted a `propertyNames` constraint; it must be gone.
    expect(args.propertyNames).toBeUndefined();
  });

  it("keeps the envelope closed and `action` constrained", () => {
    const js = jsonSchema();
    // The outer object stays strict — only the four known fields, `action` required.
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(["action"]);
    // Enum mirrors `toInput`'s switch; a drift here is a tripwire now that the
    // schema is hand-written rather than derived from Zod.
    expect(js.properties.action.enum).toEqual([
      "capabilities", "list", "get", "set", "add", "remove",
      "enable", "disable", "debug", "connect", "edit",
    ]);
  });
});
