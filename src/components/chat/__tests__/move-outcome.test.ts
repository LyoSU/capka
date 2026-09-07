import { describe, it, expect } from "vitest";
import { moveOutcome } from "@/components/projects/move-to-project-dialog";

/**
 * Moving a chat into a project takes its folders along, except the ones whose name
 * the destination already uses — a rejected move would be worse than a folder left
 * behind, so the server carries the rest and names the stragglers in
 * `foldersNotCarried`. The dialog never read the successful response, so it always
 * said "moved" and the folder just stopped being attached, with nothing said.
 *
 * (The suite runs in a node environment with no DOM, so what is testable is the
 * decision, not the toast — hence the pure export.)
 */
describe("moveOutcome", () => {
  it("names the folders that stayed behind instead of reporting a plain move", () => {
    expect(moveOutcome({ ok: true, foldersNotCarried: ["reports", "invoices"] })).toEqual({
      key: "foldersLeftBehind",
      folders: ["reports", "invoices"],
    });
  });

  it("reports a plain move when every folder came along", () => {
    // The server omits the key entirely in that case, so its absence is the signal.
    expect(moveOutcome({ ok: true })).toEqual({ key: "moved", folders: [] });
    expect(moveOutcome({ ok: true, foldersNotCarried: [] })).toEqual({ key: "moved", folders: [] });
  });

  it("does not warn about nothing when the body is missing or malformed", () => {
    for (const body of [null, undefined, "", 0, { foldersNotCarried: "reports" }, { foldersNotCarried: {} }]) {
      expect(moveOutcome(body)).toEqual({ key: "moved", folders: [] });
    }
  });

  it("drops entries that could not name a folder to the person", () => {
    expect(moveOutcome({ foldersNotCarried: ["reports", "", null, 7] })).toEqual({
      key: "foldersLeftBehind",
      folders: ["reports"],
    });
  });
});
