import { describe, it, expect } from "vitest";
import { askFormSchema, askAnswerSchema } from "../types";

describe("askFormSchema", () => {
  it("accepts a single text field", () => {
    const r = askFormSchema.safeParse({ fields: [{ id: "name", label: "Your name?", kind: "text" }] });
    expect(r.success).toBe(true);
  });
  it("accepts a multi-choice field with options", () => {
    const r = askFormSchema.safeParse({
      title: "Export",
      fields: [{ id: "fmt", label: "Format?", kind: "choice", multi: true, options: [{ value: "pdf", label: "PDF" }] }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects an empty fields array", () => {
    expect(askFormSchema.safeParse({ fields: [] }).success).toBe(false);
  });
});

describe("askAnswerSchema", () => {
  it("accepts submit with string and array values", () => {
    const r = askAnswerSchema.safeParse({ action: "submit", values: { name: "Kyiv", fmt: ["pdf"] } });
    expect(r.success).toBe(true);
  });
  it("accepts skip with empty values", () => {
    expect(askAnswerSchema.safeParse({ action: "skip", values: {} }).success).toBe(true);
  });
});
