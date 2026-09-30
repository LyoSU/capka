import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";

vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  downloadFile: vi.fn(),
  execCommand: vi.fn(),
}));
// A database write; what is asserted here is which message the bytes ride.
vi.mock("@/lib/tasks/turn-taint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tasks/turn-taint")>()),
  markMessageUntrusted: vi.fn(async () => {}),
}));

import { downloadFile, execCommand } from "@/lib/sandbox/client";
import { buildRecoveryNote } from "../effect-ledger";
import { injectNativeFiles } from "../run-attachments";
import { withoutEffectNote } from "../runner";

/**
 * The effect-ledger recovery note is a user-role message the runner adds after a
 * restart, last or right after the user's message. Native attachments are put on,
 * and stripped from, "the user's last message" — which was the note: an overflowed
 * turn re-attached the user's files to it, and a modality retry stripped nothing
 * from it and failed the same way again.
 */
const note: ModelMessage = {
  role: "user",
  content: buildRecoveryNote([{ id: "c1", name: "write_file", input: { path: "out.md" } }])!,
};
const noteText = note.content;

beforeEach(() => {
  vi.mocked(execCommand).mockReset().mockResolvedValue({ stdout: "__KEEP__", stderr: "", exitCode: 0 });
  vi.mocked(downloadFile).mockReset().mockResolvedValue(
    { arrayBuffer: async () => new ArrayBuffer(1024) } as unknown as Response,
  );
});

const partTypes = (m: ModelMessage) => (Array.isArray(m.content) ? m.content.map((p) => p.type) : [typeof m.content]);

describe("withoutEffectNote", () => {
  it("re-attaches the user's files to the user's message, not to the note placed last", async () => {
    const user: ModelMessage = { role: "user", content: "summarize this" };
    const msgs: ModelMessage[] = [user, { role: "assistant", content: "Working on it." }, note];

    const injected = await injectNativeFiles(withoutEffectNote(msgs, note), "s", "u", "openai", [{ name: "a.txt", type: "text/plain" }], "row");

    expect(injected.map((f) => f.name)).toEqual(["a.txt"]);
    expect(partTypes(user)).toEqual(["file", "text"]);
    expect(msgs[2]).toBe(note);
    expect(note.content).toBe(noteText);
  });

  // The control: the same call over the whole history is the defect this pins.
  it("without it, the note is what the files land on", async () => {
    const lookalike: ModelMessage = { ...note };
    const user: ModelMessage = { role: "user", content: "summarize this" };
    await injectNativeFiles([user, lookalike], "s", "u", "openai", [{ name: "a.txt", type: "text/plain" }], "row");
    expect(partTypes(user)).toEqual(["string"]);
    expect(partTypes(lookalike)).toEqual(["file", "text"]);
  });

  it("finds the user's message for stripping when the note sits right after it (an approval still to run)", () => {
    const user: ModelMessage = { role: "user", content: [{ type: "text", text: "see image" }, { type: "image", image: "aGk=" }] };
    const msgs: ModelMessage[] = [user, note, { role: "assistant", content: "…" }];
    expect(withoutEffectNote(msgs, note).findLast((m) => m.role === "user")).toBe(user);
  });

  it("is the history itself when there is no note", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }];
    expect(withoutEffectNote(msgs, null)).toBe(msgs);
  });
});
