import { describe, it, expect } from "vitest";
import { elicitSchemaToForm, answerToElicitResult } from "../elicit-map";

describe("elicitSchemaToForm", () => {
  it("maps a flat elicitation schema to a form", () => {
    const form = elicitSchemaToForm({
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        confirmed: { type: "boolean", title: "Confirmed?" },
        size: { type: "string", enum: ["s", "m", "l"] },
      },
      required: ["name"],
    }, "Please fill this in");
    expect(form.title).toBe("Please fill this in");
    expect(form.fields.find((f) => f.id === "name")?.optional).toBeFalsy();
    expect(form.fields.find((f) => f.id === "confirmed")?.kind).toBe("boolean");
    expect(form.fields.find((f) => f.id === "size")?.kind).toBe("choice");
    expect(form.fields.find((f) => f.id === "size")?.options?.length).toBe(3);
    expect(form.fields.find((f) => f.id === "confirmed")?.optional).toBe(true);
  });

  it("falls back to a single text field for an empty schema", () => {
    const form = elicitSchemaToForm({ type: "object", properties: {} }, "Anything?");
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0].kind).toBe("text");
  });
});

describe("answerToElicitResult", () => {
  it("maps submit to accept+content and skip to decline", () => {
    expect(answerToElicitResult({ action: "submit", values: { name: "x" } })).toEqual({ action: "accept", content: { name: "x" } });
    expect(answerToElicitResult({ action: "skip", values: {} })).toEqual({ action: "decline" });
  });
});
