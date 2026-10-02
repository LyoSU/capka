import { describe, expect, it } from "vitest";
import { insertAtCaret, isPastedText, pastedTextFile } from "@/components/chat/chat-input";

describe("paste back as text", () => {
  it("recognises only its own chips", () => {
    const f = pastedTextFile("x");
    expect(isPastedText({ name: f.name, file: f })).toBe(true);
    expect(isPastedText({ name: f.name })).toBe(false);
    expect(isPastedText({ name: "notes.txt", file: f })).toBe(false);
  });
  it("inserts over the selection and puts the caret after the text", () => {
    expect(insertAtCaret("hello world", "BIG", 6, 11)).toEqual({ value: "hello BIG", caret: 9 });
    expect(insertAtCaret("", "BIG", 0, 0)).toEqual({ value: "BIG", caret: 3 });
  });
});
