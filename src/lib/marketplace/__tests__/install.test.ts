import { describe, it, expect } from "vitest";
import * as install from "../install";

/**
 * The single-writer invariant.
 *
 * This file used to test `upgradePlugin`'s "must be a full 40-hex SHA" guard. That guard was
 * never the problem — the problem was that the function existed at all: a second path to the
 * same rows, with no operation claim, no lease, and an unconditional
 * `db.update(pluginInstalls).set({ manifest })` that would erase a live apply's `applyState`.
 * The pin discipline it enforced now lives in `resolveTarget` in the review route, where every
 * upgrade actually passes.
 *
 * So what is worth pinning is the SHAPE, not the guard: exactly one writer may move an
 * install's committed view. A structural assertion is a weak test in general, but the entire
 * class of defect here was "somebody added a second writer", and that is visible in the module
 * surface and nowhere else — no behavioural test can fail when a NEW export appears.
 */
describe("install module surface", () => {
  it("exposes no writer that can move a pin outside an operation claim", () => {
    expect(install).not.toHaveProperty("upgradePlugin");
  });

  it("keeps the readonly upgrade preview, which touches nothing", () => {
    // `previewUpgrade` is the half that was always safe: it resolves a commit and diffs two
    // trees. Deleting it along with the writer would have taken the file diff off the review
    // screen for no reason.
    expect(install.previewUpgrade).toBeTypeOf("function");
  });
});
