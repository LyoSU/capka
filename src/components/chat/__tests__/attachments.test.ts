import { describe, it, expect } from "vitest";
import { detachPlan } from "../use-attachments";

/**
 * Detaching a file has to decide what the sandbox owes, and the answer differs by
 * where the file came from. Every case here was a real outcome of the old rule,
 * which only ever deleted a `ready` chip.
 */
describe("detachPlan", () => {
  it("deletes a file this staging area uploaded once it has landed", () => {
    expect(detachPlan({ status: "ready", ref: { name: "a.png", type: "image/png" }, owned: true })).toBe("delete");
  });

  it("parks the deletion when the upload is still in flight", () => {
    // THE BUG: a chip removed mid-upload has no ref to delete, so the old code
    // did nothing at all — and the upload then finished, leaving the file in the
    // workspace with no chip left to remove it. The user saw it in the file
    // browser (and the model saw it too) after deliberately taking it off.
    expect(detachPlan({ status: "uploading", owned: true })).toBe("park");
  });

  it("keeps a file that arrived with the message being edited", () => {
    // Its name is still referenced by the transcript, and by any later turn that
    // worked on it. Editing a message detaches the file from that message; it is
    // not a way to delete files from the workspace.
    expect(detachPlan({ status: "ready", ref: { name: "report.xlsx", type: "" }, owned: false })).toBe("keep");
  });

  it("keeps nothing back for an upload that failed", () => {
    expect(detachPlan({ status: "error", owned: true })).toBe("keep");
  });
});
